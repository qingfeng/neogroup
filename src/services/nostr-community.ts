import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { groups, topics, users, authProviders, nostrFollows, nostrCommunityFollows, userFollows } from '../db/schema'
import type { User } from '../db/schema'
import {
  type NostrEvent,
  verifyEvent,
  countLeadingZeroBits,
  buildApprovalEvent,
  buildSignedEvent,
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

// --- Poll followed Nostr users ---

export async function pollFollowedUsers(env: Bindings, db: Database) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Get all distinct followed pubkeys
  const follows = await db
    .select({
      targetPubkey: nostrFollows.targetPubkey,
      lastPollAt: sql<number>`MIN(${nostrFollows.lastPollAt})`.as('min_poll'),
    })
    .from(nostrFollows)
    .groupBy(nostrFollows.targetPubkey)

  if (follows.length === 0) return

  const relayUrl = relayUrls[0]
  const BATCH_SIZE = 50

  for (let i = 0; i < follows.length; i += BATCH_SIZE) {
    const batch = follows.slice(i, i + BATCH_SIZE)
    const pubkeys = batch.map(f => f.targetPubkey)
    const minSince = batch.reduce((min, f) => {
      const pollAt = f.lastPollAt || 0
      return pollAt < min ? pollAt : min
    }, Math.floor(Date.now() / 1000) - 3600) // Default: last hour

    try {
      const events = await fetchEventsFromRelay(relayUrl, {
        kinds: [1],
        authors: pubkeys,
        since: minSince,
      })

      console.log(`[Nostr Follow] Fetched ${events.length} events from ${pubkeys.length} authors since ${minSince}`)

      for (const event of events) {
        try {
          // Verify signature
          if (!verifyEvent(event)) continue

          // Dedup
          const existing = await db.select({ id: topics.id })
            .from(topics)
            .where(eq(topics.nostrEventId, event.id))
            .limit(1)
          if (existing.length > 0) continue

          // Skip events with NIP-72 community tags (they belong to groups, not personal timeline)
          const hasATag = event.tags.some(t => t[0] === 'a' && t[1]?.startsWith('34550:'))
          if (hasATag) continue

          // Reject future timestamps
          const nowSec = Math.floor(Date.now() / 1000)
          if (event.created_at > nowSec + 600) continue

          // Get or create shadow user
          const author = await getOrCreateNostrUser(db, event.pubkey)

          // Personal post: groupId = null, title = ''
          const escaped = event.content
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
            groupId: null,
            userId: author.id,
            title: '',
            content: htmlContent,
            type: 0,
            nostrEventId: event.id,
            nostrAuthorPubkey: event.pubkey,
            createdAt: topicNow,
            updatedAt: topicNow,
          })

          console.log(`[Nostr Follow] Imported post ${topicId} from ${event.pubkey.slice(0, 8)}...`)
        } catch (e) {
          console.error(`[Nostr Follow] Failed to process event ${event.id}:`, e)
        }
      }

      // Update last_poll_at for all pubkeys in this batch
      const nowTs = Math.floor(Date.now() / 1000)
      for (const pk of pubkeys) {
        await db.update(nostrFollows)
          .set({ lastPollAt: nowTs })
          .where(eq(nostrFollows.targetPubkey, pk))
      }
    } catch (e) {
      console.error('[Nostr Follow] Poll failed:', e)
    }
  }
}

// --- Poll followed Nostr communities ---

export async function pollFollowedCommunities(env: Bindings, db: Database) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  const communityFollows = await db
    .select()
    .from(nostrCommunityFollows)

  if (communityFollows.length === 0) return

  const relayUrl = relayUrls[0]
  const minPow = parseInt(env.NOSTR_MIN_POW || '20', 10)

  for (const cf of communityFollows) {
    try {
      const aTag = `34550:${cf.communityPubkey}:${cf.communityDTag}`
      const since = cf.lastPollAt || Math.floor(Date.now() / 1000) - 3600

      const useRelay = cf.communityRelay || relayUrl

      const events = await fetchEventsFromRelay(useRelay, {
        kinds: [1],
        '#a': [aTag],
        since,
      })

      console.log(`[Nostr Community Follow] ${cf.communityDTag}: fetched ${events.length} events since ${since}`)

      if (!cf.localGroupId) continue

      let maxCreatedAt = since
      for (const event of events) {
        try {
          // Use processIncomingPost-like logic but without approval event
          if (!verifyEvent(event)) continue
          if (countLeadingZeroBits(event.id) < minPow) continue

          const nowSec = Math.floor(Date.now() / 1000)
          if (event.created_at > nowSec + 600) continue

          const existing = await db.select({ id: topics.id })
            .from(topics)
            .where(eq(topics.nostrEventId, event.id))
            .limit(1)
          if (existing.length > 0) {
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          const author = await getOrCreateNostrUser(db, event.pubkey)

          const lines = event.content.split('\n')
          const rawTitle = (lines[0] || '').trim()
          const title = truncate(rawTitle || 'Nostr 帖子', 100)
          const restContent = lines.slice(1).join('\n').trim()
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
            groupId: cf.localGroupId,
            userId: author.id,
            title,
            content: htmlContent,
            type: 0,
            nostrEventId: event.id,
            nostrAuthorPubkey: event.pubkey,
            createdAt: topicNow,
            updatedAt: topicNow,
          })

          console.log(`[Nostr Community Follow] Created topic ${topicId} in group ${cf.localGroupId}`)
        } catch (e) {
          console.error(`[Nostr Community Follow] Failed to process event ${event.id}:`, e)
        }
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      }

      if (events.length > 0) {
        await db.update(nostrCommunityFollows)
          .set({ lastPollAt: maxCreatedAt + 1 })
          .where(eq(nostrCommunityFollows.id, cf.id))
      }
    } catch (e) {
      console.error(`[Nostr Community Follow] Poll failed for ${cf.communityDTag}:`, e)
    }
  }
}

// --- NIP-02 Kind 3 Contact List Sync ---

/**
 * Fetch the user's latest Kind 3 from relay, merge with local follows,
 * save new follows to local DB, then publish merged Kind 3.
 */
export async function syncAndPublishContactList(db: Database, env: Bindings, user: User) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0 || !user.nostrPubkey) return

  // 1. Get local follows
  const localFollows = await db
    .select({ targetPubkey: nostrFollows.targetPubkey })
    .from(nostrFollows)
    .where(eq(nostrFollows.userId, user.id))
  const localPubkeys = new Set(localFollows.map(f => f.targetPubkey))

  // 2. Fetch latest Kind 3 from relay
  const relayPubkeys = new Set<string>()
  try {
    const events = await fetchEventsFromRelay(relayUrls[0], {
      kinds: [3],
      authors: [user.nostrPubkey],
      limit: 1,
    })
    if (events.length > 0) {
      // Take the most recent Kind 3
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      for (const tag of latest.tags) {
        if (tag[0] === 'p' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1])) {
          relayPubkeys.add(tag[1].toLowerCase())
        }
      }
    }
  } catch (e) {
    console.error('[Nostr K3] Failed to fetch Kind 3 from relay:', e)
  }

  // 3. Import new follows from relay to local DB
  for (const pk of relayPubkeys) {
    if (localPubkeys.has(pk)) continue
    try {
      await db.insert(nostrFollows).values({
        id: generateId(),
        userId: user.id,
        targetPubkey: pk,
        targetNpub: pubkeyToNpub(pk),
        createdAt: new Date(),
      })
      localPubkeys.add(pk)

      // Create shadow user + user_follow
      const shadowUser = await getOrCreateNostrUser(db, pk)
      const existingFollow = await db
        .select({ id: userFollows.id })
        .from(userFollows)
        .where(and(eq(userFollows.followerId, user.id), eq(userFollows.followeeId, shadowUser.id)))
        .limit(1)
      if (existingFollow.length === 0) {
        await db.insert(userFollows).values({
          id: generateId(),
          followerId: user.id,
          followeeId: shadowUser.id,
          createdAt: new Date(),
        })
      }
      console.log(`[Nostr K3] Imported follow ${pk.slice(0, 8)}... from relay for user ${user.id}`)
    } catch (e) {
      // Likely unique constraint — already exists
    }
  }

  // 4. Merge: all pubkeys from both local and relay
  const mergedPubkeys = new Set([...localPubkeys, ...relayPubkeys])
  const tags: string[][] = Array.from(mergedPubkeys).map(pk => ['p', pk])

  // 5. Publish merged Kind 3
  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !env.NOSTR_MASTER_KEY) return

  const event = await buildSignedEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: env.NOSTR_MASTER_KEY,
    kind: 3,
    content: '',
    tags,
  })

  await env.NOSTR_QUEUE!.send({ events: [event] })
  console.log(`[Nostr K3] Published Kind 3 with ${tags.length} follows (local: ${localFollows.length}, relay: ${relayPubkeys.size}) for user ${user.id}`)
}

/**
 * Cron: sync Kind 3 contact lists from relay for all Nostr-enabled users.
 */
export async function syncContactListsFromRelay(env: Bindings, db: Database) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Get all users with Nostr sync enabled and a pubkey
  const nostrUsers = await db
    .select({
      id: users.id,
      nostrPubkey: users.nostrPubkey,
    })
    .from(users)
    .where(and(eq(users.nostrSyncEnabled, 1), sql`${users.nostrPubkey} IS NOT NULL`))

  if (nostrUsers.length === 0) return

  const relayUrl = relayUrls[0]

  // Batch fetch: get all Kind 3 events for all users at once
  const pubkeys = nostrUsers.map(u => u.nostrPubkey!).filter(Boolean)
  let kind3Events: NostrEvent[] = []
  try {
    kind3Events = await fetchEventsFromRelay(relayUrl, {
      kinds: [3],
      authors: pubkeys,
    })
  } catch (e) {
    console.error('[Nostr K3 Sync] Failed to fetch Kind 3 events:', e)
    return
  }

  // Group by author, keep latest per author
  const latestByAuthor = new Map<string, NostrEvent>()
  for (const ev of kind3Events) {
    const existing = latestByAuthor.get(ev.pubkey)
    if (!existing || ev.created_at > existing.created_at) {
      latestByAuthor.set(ev.pubkey, ev)
    }
  }

  // For each user, import new follows from their Kind 3
  for (const u of nostrUsers) {
    const event = latestByAuthor.get(u.nostrPubkey!)
    if (!event) continue

    const relayFollowPubkeys: string[] = []
    for (const tag of event.tags) {
      if (tag[0] === 'p' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1])) {
        relayFollowPubkeys.push(tag[1].toLowerCase())
      }
    }

    if (relayFollowPubkeys.length === 0) continue

    // Get existing local follows
    const localFollows = await db
      .select({ targetPubkey: nostrFollows.targetPubkey })
      .from(nostrFollows)
      .where(eq(nostrFollows.userId, u.id))
    const localSet = new Set(localFollows.map(f => f.targetPubkey))

    let imported = 0
    for (const pk of relayFollowPubkeys) {
      if (localSet.has(pk)) continue
      try {
        await db.insert(nostrFollows).values({
          id: generateId(),
          userId: u.id,
          targetPubkey: pk,
          targetNpub: pubkeyToNpub(pk),
          createdAt: new Date(),
        })

        // Create shadow user + user_follow
        const shadowUser = await getOrCreateNostrUser(db, pk)
        const existingFollow = await db
          .select({ id: userFollows.id })
          .from(userFollows)
          .where(and(eq(userFollows.followerId, u.id), eq(userFollows.followeeId, shadowUser.id)))
          .limit(1)
        if (existingFollow.length === 0) {
          await db.insert(userFollows).values({
            id: generateId(),
            followerId: u.id,
            followeeId: shadowUser.id,
            createdAt: new Date(),
          })
        }
        imported++
      } catch (e) {
        // Unique constraint — skip
      }
    }

    if (imported > 0) {
      console.log(`[Nostr K3 Sync] Imported ${imported} follows from relay for user ${u.id}`)
    }
  }
}
