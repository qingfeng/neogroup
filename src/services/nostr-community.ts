import { eq, and } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { groups, topics, users, authProviders } from '../db/schema'
import {
  type NostrEvent,
  verifyEvent,
  countLeadingZeroBits,
  buildApprovalEvent,
  pubkeyToNpub,
} from './nostr'
import { generateId, truncate } from '../lib/utils'

// --- Cron entry point ---

export async function pollCommunityPosts(env: Bindings, db: Database) {
  const enabledGroups = await db
    .select({
      id: groups.id,
      actorName: groups.actorName,
      nostrPubkey: groups.nostrPubkey,
      nostrPrivEncrypted: groups.nostrPrivEncrypted,
      nostrPrivIv: groups.nostrPrivIv,
      nostrLastPollAt: groups.nostrLastPollAt,
    })
    .from(groups)
    .where(eq(groups.nostrSyncEnabled, 1))

  if (enabledGroups.length === 0) return

  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) {
    console.error('[NIP-72] No relays configured')
    return
  }

  const minPow = parseInt(env.NOSTR_MIN_POW || '20', 10)
  const relayUrl = relayUrls[0] // Use first relay for polling

  for (const group of enabledGroups) {
    if (!group.nostrPubkey || !group.actorName) continue

    try {
      const aTag = `34550:${group.nostrPubkey}:${group.actorName}`
      const since = group.nostrLastPollAt || Math.floor(Date.now() / 1000) - 3600 // Default: last hour

      const events = await fetchEventsFromRelay(relayUrl, {
        kinds: [1, 1111],
        '#a': [aTag],
        since,
      })

      console.log(`[NIP-72] ${group.actorName}: fetched ${events.length} events since ${since}`)

      let maxCreatedAt = since
      for (const event of events) {
        try {
          await processIncomingPost(db, env, group, event, minPow)
        } catch (e) {
          console.error(`[NIP-72] Failed to process event ${event.id}:`, e)
        }
        if (event.created_at > maxCreatedAt) {
          maxCreatedAt = event.created_at
        }
      }

      // Update last poll timestamp (add 1 to avoid re-fetching the same event, since `since` is inclusive)
      if (events.length > 0) {
        await db.update(groups)
          .set({ nostrLastPollAt: maxCreatedAt + 1 })
          .where(eq(groups.id, group.id))
      }
    } catch (e) {
      console.error(`[NIP-72] Poll failed for group ${group.actorName}:`, e)
    }
  }
}

// --- WebSocket REQ ---

export async function fetchEventsFromRelay(
  relayUrl: string,
  filter: Record<string, any>,
): Promise<NostrEvent[]> {
  const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://')
  const resp = await fetch(httpUrl, {
    headers: { Upgrade: 'websocket' },
  })

  const ws = (resp as any).webSocket as WebSocket
  if (!ws) {
    throw new Error('WebSocket upgrade failed')
  }
  ws.accept()

  const subId = 'nip72-' + Math.random().toString(36).slice(2, 8)
  const events: NostrEvent[] = []

  return new Promise<NostrEvent[]>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        ws.send(JSON.stringify(['CLOSE', subId]))
        ws.close()
      } catch {}
      resolve(events)
    }, 15000)

    ws.addEventListener('message', (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string)
        if (!Array.isArray(data)) return

        if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
          events.push(data[2] as NostrEvent)
        } else if (data[0] === 'EOSE' && data[1] === subId) {
          clearTimeout(timeout)
          try {
            ws.send(JSON.stringify(['CLOSE', subId]))
            ws.close()
          } catch {}
          resolve(events)
        }
      } catch {}
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
      resolve(events)
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      resolve(events)
    })

    // Send REQ
    ws.send(JSON.stringify(['REQ', subId, filter]))
  })
}

// --- Process incoming post ---

async function processIncomingPost(
  db: Database,
  env: Bindings,
  group: {
    id: string
    actorName: string | null
    nostrPubkey: string | null
    nostrPrivEncrypted: string | null
    nostrPrivIv: string | null
  },
  event: NostrEvent,
  minPow: number,
) {
  // Skip events from the group's own pubkey (avoid loop)
  if (event.pubkey === group.nostrPubkey) return

  // Reject events with future timestamps (10 minute tolerance)
  const nowSec = Math.floor(Date.now() / 1000)
  if (event.created_at > nowSec + 600) {
    console.log(`[NIP-72] Future event rejected: ${event.id}`)
    return
  }

  // Verify event signature
  if (!verifyEvent(event)) {
    console.log(`[NIP-72] Invalid signature for event ${event.id}`)
    return
  }

  // Check PoW difficulty
  if (countLeadingZeroBits(event.id) < minPow) {
    console.log(`[NIP-72] Insufficient PoW for event ${event.id}: ${countLeadingZeroBits(event.id)} < ${minPow}`)
    return
  }

  // Dedup: check if already imported
  const existing = await db.select({ id: topics.id })
    .from(topics)
    .where(eq(topics.nostrEventId, event.id))
    .limit(1)
  if (existing.length > 0) return

  // Get or create shadow user for this Nostr pubkey
  const author = await getOrCreateNostrUser(db, event.pubkey)

  // Parse content: first line as title, rest as content
  const lines = event.content.split('\n')
  const rawTitle = (lines[0] || '').trim()
  const title = truncate(rawTitle || 'Nostr 帖子', 100)
  const restContent = lines.slice(1).join('\n').trim()
  // Escape HTML to prevent XSS from untrusted Nostr content
  const escaped = restContent
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const htmlContent = escaped
    ? '<p>' + escaped.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
    : null

  const topicId = generateId()
  const topicNow = new Date(event.created_at * 1000)

  await db.insert(topics).values({
    id: topicId,
    groupId: group.id,
    userId: author.id,
    title,
    content: htmlContent,
    type: 0,
    nostrEventId: event.id,
    nostrAuthorPubkey: event.pubkey,
    createdAt: topicNow,
    updatedAt: topicNow,
  })

  console.log(`[NIP-72] Created topic ${topicId} from event ${event.id} by ${event.pubkey.slice(0, 8)}...`)

  // Send Kind 4550 approval event via queue
  if (env.NOSTR_QUEUE && env.NOSTR_MASTER_KEY && group.nostrPrivEncrypted && group.nostrPrivIv && group.nostrPubkey && group.actorName) {
    try {
      const relayUrl = (env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
      const approval = await buildApprovalEvent({
        privEncrypted: group.nostrPrivEncrypted,
        iv: group.nostrPrivIv,
        masterKey: env.NOSTR_MASTER_KEY,
        communityPubkey: group.nostrPubkey,
        dTag: group.actorName,
        approvedEvent: event,
        relayUrl,
      })
      await env.NOSTR_QUEUE.send({ events: [approval] })
      console.log(`[NIP-72] Queued approval event for ${event.id}`)
    } catch (e) {
      console.error(`[NIP-72] Failed to build/send approval:`, e)
    }
  }
}

// --- Nostr shadow user ---

export async function getOrCreateNostrUser(
  db: Database,
  pubkey: string,
): Promise<{ id: string; username: string }> {
  // Check if auth_provider exists for this Nostr pubkey
  const existing = await db
    .select({
      userId: authProviders.userId,
      username: users.username,
    })
    .from(authProviders)
    .innerJoin(users, eq(authProviders.userId, users.id))
    .where(and(
      eq(authProviders.providerType, 'nostr'),
      eq(authProviders.providerId, pubkey),
    ))
    .limit(1)

  if (existing.length > 0) {
    return { id: existing[0].userId, username: existing[0].username }
  }

  // Create shadow user with unique username
  const npub = pubkeyToNpub(pubkey)
  let username = npub.slice(0, 16) // npub1xxxxxxxx
  const displayName = npub.slice(0, 12) + '...'
  const userId = generateId()
  const now = new Date()

  // Ensure username uniqueness
  const existingUser = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
  if (existingUser.length > 0) {
    username = npub.slice(0, 12) + '_' + Math.random().toString(36).slice(2, 6)
  }

  await db.insert(users).values({
    id: userId,
    username,
    displayName,
    createdAt: now,
    updatedAt: now,
  })

  await db.insert(authProviders).values({
    id: generateId(),
    userId,
    providerType: 'nostr',
    providerId: pubkey,
    metadata: JSON.stringify({ npub }),
    createdAt: now,
  })

  console.log(`[NIP-72] Created shadow user ${username} for pubkey ${pubkey.slice(0, 8)}...`)
  return { id: userId, username }
}
