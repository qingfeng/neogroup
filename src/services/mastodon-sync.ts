import type { Database } from '../db'
import { eq, and } from 'drizzle-orm'
import { topics, comments, users, authProviders } from '../db/schema'
import { generateId } from '../lib/utils'

const SYNC_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

interface MastodonStatus {
  id: string
  content: string
  account: {
    id: string
    username: string
    acct: string
    display_name: string
    avatar: string
    url: string
  }
  created_at: string
  in_reply_to_id: string | null
}

interface MastodonContext {
  ancestors: MastodonStatus[]
  descendants: MastodonStatus[]
}

async function fetchMastodonReplies(
  domain: string,
  statusId: string
): Promise<MastodonStatus[]> {
  const response = await fetch(
    `https://${domain}/api/v1/statuses/${statusId}/context`
  )
  if (!response.ok) {
    console.error(`Mastodon context API error: ${response.status}`)
    return []
  }
  const context = (await response.json()) as MastodonContext
  return context.descendants
}

export async function syncMastodonReplies(
  db: Database,
  topicId: string,
  mastodonDomain: string,
  mastodonStatusId: string,
): Promise<void> {
  // 1. Check cooldown
  const topicRow = await db
    .select({ mastodonSyncedAt: topics.mastodonSyncedAt })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicRow.length === 0) return

  const lastSynced = topicRow[0].mastodonSyncedAt
  if (lastSynced && (Date.now() - lastSynced.getTime()) < SYNC_COOLDOWN_MS) {
    return
  }

  // 2. Fetch replies from Mastodon
  const descendants = await fetchMastodonReplies(mastodonDomain, mastodonStatusId)

  if (descendants.length === 0) {
    await db.update(topics)
      .set({ mastodonSyncedAt: new Date() })
      .where(eq(topics.id, topicId))
    return
  }

  // 3. Get already-synced Mastodon status IDs for this topic
  const existingComments = await db
    .select({ id: comments.id, mastodonStatusId: comments.mastodonStatusId })
    .from(comments)
    .where(eq(comments.topicId, topicId))

  const existingStatusIds = new Set(
    existingComments
      .map(c => c.mastodonStatusId)
      .filter((id): id is string => id !== null)
  )

  // 4. Filter to only new replies
  const newReplies = descendants.filter(d => !existingStatusIds.has(d.id))

  if (newReplies.length === 0) {
    await db.update(topics)
      .set({ mastodonSyncedAt: new Date() })
      .where(eq(topics.id, topicId))
    return
  }

  // 5. Build a map from mastodon status ID -> comment ID (for replyToId resolution)
  const statusToCommentId = new Map<string, string>()
  for (const c of existingComments) {
    if (c.mastodonStatusId) {
      statusToCommentId.set(c.mastodonStatusId, c.id)
    }
  }

  // Pre-generate IDs for new replies so we can resolve in_reply_to references among the batch
  const replyIdMap = new Map<string, string>()
  for (const reply of newReplies) {
    replyIdMap.set(reply.id, generateId())
  }

  // 6. Process each new reply
  const now = new Date()
  for (const reply of newReplies) {
    const userId = await getOrCreateMastodonUser(db, reply.account, mastodonDomain)
    const commentId = replyIdMap.get(reply.id)!

    // Resolve replyToId
    let replyToId: string | null = null
    if (reply.in_reply_to_id && reply.in_reply_to_id !== mastodonStatusId) {
      replyToId = statusToCommentId.get(reply.in_reply_to_id)
        ?? replyIdMap.get(reply.in_reply_to_id)
        ?? null
    }

    const createdAt = new Date(reply.created_at)

    await db.insert(comments).values({
      id: commentId,
      topicId,
      userId,
      content: reply.content,
      replyToId,
      mastodonStatusId: reply.id,
      createdAt,
      updatedAt: createdAt,
    })

    statusToCommentId.set(reply.id, commentId)
  }

  // 7. Update topic timestamps
  await db.update(topics)
    .set({
      mastodonSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(topics.id, topicId))
}

async function getOrCreateMastodonUser(
  db: Database,
  account: MastodonStatus['account'],
  queriedDomain: string
): Promise<string> {
  const isLocalAccount = !account.acct.includes('@')

  // 1. For local accounts, try matching to existing registered user
  if (isLocalAccount) {
    const providerId = `${account.id}@${queriedDomain}`
    const existing = await db.query.authProviders.findFirst({
      where: and(
        eq(authProviders.providerType, 'mastodon'),
        eq(authProviders.providerId, providerId)
      ),
    })
    if (existing) {
      return existing.userId
    }
  }

  // 2. Generate virtual username
  const acctFull = isLocalAccount
    ? `${account.username}@${queriedDomain}`
    : account.acct
  const virtualUsername = `m_${acctFull.replace(/@/g, '_').replace(/\./g, '_')}`

  // 3. Check if virtual user already exists
  const existingUser = await db.query.users.findFirst({
    where: eq(users.username, virtualUsername),
  })
  if (existingUser) {
    return existingUser.id
  }

  // 4. Create new virtual user
  const userId = generateId()
  const now = new Date()

  await db.insert(users).values({
    id: userId,
    username: virtualUsername,
    displayName: account.display_name || account.username,
    avatarUrl: account.avatar,
    bio: null,
    createdAt: now,
    updatedAt: now,
  })

  return userId
}
