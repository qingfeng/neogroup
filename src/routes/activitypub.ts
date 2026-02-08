import { Hono } from 'hono'
import { eq, desc, sql, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { authProviders, users, apFollowers, topics, comments, groups, groupFollowers } from '../db/schema'
import { generateId, stripHtml, truncate } from '../lib/utils'
import { createNotification } from '../lib/notifications'
import {
  ensureKeyPair, getWebFingerJson, getActorJson, getNodeInfoJson,
  fetchActor, signAndDeliver, getNoteJson, getCommentNoteJson, getApUsername,
  getGroupWebFingerJson, getGroupActorJson, ensureGroupKeyPair, getOrCreateRemoteUser,
  boostToGroupFollowers
} from '../services/activitypub'

const ap = new Hono<AppContext>()

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Resolve AP username to local user by users.username (unique)
async function findUserByApUsername(db: ReturnType<typeof import('../db').createDb>, username: string) {
  const userResult = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1)

  if (userResult.length === 0) return null
  return userResult[0]
}

// --- WebFinger ---
ap.get('/.well-known/webfinger', async (c) => {
  const resource = c.req.query('resource')
  if (!resource) {
    return c.json({ error: 'Missing resource parameter' }, 400)
  }

  // Parse acct:username@domain
  const match = resource.match(/^acct:([^@]+)@(.+)$/)
  if (!match) {
    return c.json({ error: 'Invalid resource format' }, 400)
  }

  const [, username, domain] = match
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const expectedHost = new URL(baseUrl).host

  if (domain !== expectedHost) {
    return c.json({ error: 'Unknown domain' }, 404)
  }

  const db = c.get('db')

  // First try to find a user
  const user = await findUserByApUsername(db, username)
  if (user) {
    return c.json(getWebFingerJson(username, user.id, baseUrl), 200, {
      'Content-Type': 'application/jrd+json',
      'Access-Control-Allow-Origin': '*',
    })
  }

  // If no user found, try to find a group by actorName
  const groupResult = await db.select({ id: groups.id, actorName: groups.actorName })
    .from(groups)
    .where(eq(groups.actorName, username))
    .limit(1)

  if (groupResult.length > 0 && groupResult[0].actorName) {
    return c.json(getGroupWebFingerJson(groupResult[0].actorName, groupResult[0].id, baseUrl), 200, {
      'Content-Type': 'application/jrd+json',
      'Access-Control-Allow-Origin': '*',
    })
  }

  return c.json({ error: 'Not found' }, 404)
})

// --- Actor ---
ap.get('/ap/users/:username', async (c) => {
  const username = c.req.param('username')
  const db = c.get('db')

  const user = await findUserByApUsername(db, username)
  if (!user) {
    return c.notFound()
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const { publicKeyPem } = await ensureKeyPair(db, user.id)

  const actor = getActorJson(user, username, publicKeyPem, baseUrl)

  return c.json(actor, 200, {
    'Content-Type': 'application/activity+json',
    'Access-Control-Allow-Origin': '*',
  })
})

// --- Group Actor (FEP-1b12) ---
ap.get('/ap/groups/:actorName', async (c) => {
  const actorName = c.req.param('actorName')
  const db = c.get('db')

  const groupResult = await db.select()
    .from(groups)
    .where(eq(groups.actorName, actorName))
    .limit(1)

  if (groupResult.length === 0 || !groupResult[0].actorName) {
    return c.notFound()
  }

  const group = groupResult[0]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const { publicKeyPem } = await ensureGroupKeyPair(db, group.id)

  const actor = getGroupActorJson({
    id: group.id,
    name: group.name,
    actorName: group.actorName,
    description: group.description,
    iconUrl: group.iconUrl,
  }, publicKeyPem, baseUrl)

  return c.json(actor, 200, {
    'Content-Type': 'application/activity+json',
    'Access-Control-Allow-Origin': '*',
  })
})

// --- Group Inbox (FEP-1b12 Follow handling) ---
ap.post('/ap/groups/:actorName/inbox', async (c) => {
  const actorName = c.req.param('actorName')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const groupResult = await db.select()
    .from(groups)
    .where(eq(groups.actorName, actorName))
    .limit(1)

  if (groupResult.length === 0 || !groupResult[0].actorName) {
    return c.json({ error: 'Group not found' }, 404)
  }

  const group = groupResult[0]
  let activity: Record<string, any>
  try {
    activity = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const type = activity.type
  console.log('[AP GroupInbox] Received activity:', { type, actor: activity.actor, groupActorName: actorName })

  if (type === 'Follow') {
    // Handle Follow - auto accept and add to followers
    const followerActorUri = activity.actor
    if (!followerActorUri) {
      return c.json({ error: 'Missing actor' }, 400)
    }

    const remoteActor = await fetchActor(followerActorUri)
    if (!remoteActor) {
      return c.json({ error: 'Could not fetch remote actor' }, 400)
    }

    const inboxUrl = remoteActor.inbox
    if (!inboxUrl) {
      return c.json({ error: 'Remote actor has no inbox' }, 400)
    }

    // Save follower
    const existingFollower = await db.select({ id: groupFollowers.id })
      .from(groupFollowers)
      .where(and(eq(groupFollowers.groupId, group.id), eq(groupFollowers.actorUri, followerActorUri)))
      .limit(1)

    if (existingFollower.length === 0) {
      await db.insert(groupFollowers).values({
        id: generateId(),
        groupId: group.id,
        actorUri: followerActorUri,
        actorInbox: remoteActor.inbox || null,
        actorSharedInbox: remoteActor.endpoints?.sharedInbox || null,
        createdAt: new Date(),
      })
    }

    // Send Accept
    const groupActorUrl = `${baseUrl}/ap/groups/${actorName}`
    const { privateKeyPem } = await ensureGroupKeyPair(db, group.id)

    const accept = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${groupActorUrl}#accept-${Date.now()}`,
      type: 'Accept',
      actor: groupActorUrl,
      object: activity,
    }

    c.executionCtx.waitUntil(
      signAndDeliver(groupActorUrl, privateKeyPem, inboxUrl, accept).catch(e =>
        console.error('[AP GroupInbox] Failed to deliver Accept:', e)
      )
    )

    console.log('[AP GroupInbox] Accepted follow from:', followerActorUri)
    return c.json({ status: 'accepted' }, 202)
  }

  if (type === 'Undo') {
    const innerObject = activity.object
    if (innerObject?.type === 'Follow') {
      const followerActorUri = activity.actor
      if (followerActorUri) {
        await db.delete(groupFollowers)
          .where(and(eq(groupFollowers.groupId, group.id), eq(groupFollowers.actorUri, followerActorUri)))
        console.log('[AP GroupInbox] Removed follower:', followerActorUri)
      }
    }
    return c.json({ status: 'accepted' }, 202)
  }

  if (type === 'Create') {
    // Handle Create Note - could be @mention (new topic) or reply (comment)
    const obj = activity.object
    if (obj?.type === 'Note') {
      const noteId = obj.id || `note-${Date.now()}`
      const content = obj.content || ''
      const actorUri = activity.actor
      const inReplyTo = obj.inReplyTo as string | undefined

      // Fetch the remote actor info
      const remoteActor = await fetchActor(actorUri)
      const actorName = remoteActor?.preferredUsername || 'fediverse_user'

      // Get or create local user for the remote actor
      const author = await getOrCreateRemoteUser(db, actorUri, remoteActor)
      const userId = author ? author.id : group.creatorId


      // Check if this is a reply to an existing topic
      if (inReplyTo) {
        let topicId: string | null = null
        let replyToCommentId: string | null = null

        // 1. Check if reply to local topic URL
        const topicMatch = inReplyTo.match(/\/topic\/([a-zA-Z0-9_-]+)/)
        if (topicMatch) {
          topicId = topicMatch[1]
        } else {
          // 2. Check if reply to known Fediverse object (Topic)
          const parentTopic = await db.select({ id: topics.id })
            .from(topics)
            .where(eq(topics.mastodonStatusId, inReplyTo))
            .limit(1)

          if (parentTopic.length > 0) {
            topicId = parentTopic[0].id
          } else {
            // 3. Check if reply to known Fediverse object (Comment)
            const parentComment = await db.select({ id: comments.id, topicId: comments.topicId })
              .from(comments)
              .where(eq(comments.mastodonStatusId, inReplyTo))
              .limit(1)

            if (parentComment.length > 0) {
              topicId = parentComment[0].topicId
              replyToCommentId = parentComment[0].id
            }
          }
        }

        if (topicId) {
          // Verify topic exists
          const topicResult = await db.select({ id: topics.id, userId: topics.userId })
            .from(topics)
            .where(eq(topics.id, topicId))
            .limit(1)

          if (topicResult.length > 0) {
            // Create comment from reply
            const commentId = generateId()
            const commentNow = new Date()
            const htmlContent = content // Use original content

            await db.insert(comments).values({
              id: commentId,
              topicId,
              userId: userId,
              content: htmlContent,
              replyToId: replyToCommentId,
              mastodonStatusId: noteId,
              mastodonDomain: 'activitypub_origin',
              createdAt: commentNow,
              updatedAt: commentNow,
            })

            // Update topic updatedAt
            await db.update(topics).set({ updatedAt: commentNow }).where(eq(topics.id, topicId))

            console.log('[AP GroupInbox] Created comment from reply:', { commentId, topicId, actorName, userId, inReplyTo })
            return c.json({ status: 'created' }, 202)
          }
        }
      }

      // Not a reply - create new topic from @mention
      const textContent = stripHtml(content)
      // Remove @mentions from title
      const cleanedText = textContent.replace(/@[^\s]+/g, '').trim()
      const title = truncate(cleanedText.split('\n')[0] || 'Fediverse 帖子', 100)
      const fullContent = content

      const topicId = generateId()
      const topicNow = new Date()

      await db.insert(topics).values({
        id: topicId,
        groupId: group.id,
        userId: userId,
        title: title,
        content: fullContent,
        type: 1,
        mastodonStatusId: noteId,
        mastodonDomain: 'activitypub_origin',
        createdAt: topicNow,
        updatedAt: topicNow,
      })

      console.log('[AP GroupInbox] Created topic from @mention:', { topicId, actorName, noteId })

      // Announce (Boost) to group followers
      c.executionCtx.waitUntil(
        boostToGroupFollowers(db, group.actorName!, noteId, baseUrl)
      )

      return c.json({ status: 'created' }, 202)
    }
    return c.json({ status: 'accepted' }, 202)
  }

  // Unknown activity type - accept silently
  return c.json({ status: 'accepted' }, 202)
})

// --- Inbox ---
ap.post('/ap/users/:username/inbox', async (c) => {
  const username = c.req.param('username')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const user = await findUserByApUsername(db, username)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  let activity: Record<string, any>
  try {
    activity = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const type = activity.type

  if (type === 'Follow') {
    // Handle Follow
    const followerActorUri = activity.actor
    if (!followerActorUri) {
      return c.json({ error: 'Missing actor' }, 400)
    }

    const remoteActor = await fetchActor(followerActorUri)
    if (!remoteActor) {
      return c.json({ error: 'Could not fetch remote actor' }, 400)
    }

    const inboxUrl = remoteActor.inbox as string
    const sharedInboxUrl = (remoteActor.endpoints?.sharedInbox as string) || null

    if (!inboxUrl) {
      return c.json({ error: 'Remote actor has no inbox' }, 400)
    }

    // Upsert follower
    const existing = await db
      .select()
      .from(apFollowers)
      .where(and(eq(apFollowers.userId, user.id), eq(apFollowers.actorUri, followerActorUri)))
      .limit(1)

    if (existing.length === 0) {
      await db.insert(apFollowers).values({
        id: generateId(),
        userId: user.id,
        actorUri: followerActorUri,
        inboxUrl,
        sharedInboxUrl,
        createdAt: new Date(),
      })
    }

    // Send Accept
    const actorUrl = `${baseUrl}/ap/users/${username}`
    const { privateKeyPem } = await ensureKeyPair(db, user.id)

    const accept = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${actorUrl}#accept-${Date.now()}`,
      type: 'Accept',
      actor: actorUrl,
      object: activity,
    }

    c.executionCtx.waitUntil(
      signAndDeliver(actorUrl, privateKeyPem, inboxUrl, accept).catch(e =>
        console.error('Failed to deliver Accept:', e)
      )
    )

    return c.json({ status: 'accepted' }, 202)
  }

  if (type === 'Undo') {
    const innerObject = activity.object
    if (innerObject?.type === 'Follow') {
      const followerActorUri = activity.actor
      if (followerActorUri) {
        await db
          .delete(apFollowers)
          .where(and(eq(apFollowers.userId, user.id), eq(apFollowers.actorUri, followerActorUri)))
      }
    }
    return c.json({ status: 'accepted' }, 202)
  }

  if (type === 'Create') {
    const noteObject = typeof activity.object === 'object' ? activity.object : null
    if (noteObject?.type === 'Note') {
      const actorUrl = `${baseUrl}/ap/users/${username}`
      const host = new URL(baseUrl).host
      const expectedMention = `@${username}@${host}`
      const tags = Array.isArray(noteObject.tag) ? noteObject.tag : []

      // Debug logging
      console.log('[AP Inbox] Create(Note) received:', {
        actor: activity.actor,
        targetUser: username,
        actorUrl,
        expectedMention,
        tags: JSON.stringify(tags),
      })

      // Match by href (actor URL) OR by name (@username@domain)
      const isMentioned = tags.some(
        (t: any) => t.type === 'Mention' && (
          t.href === actorUrl ||
          t.name === expectedMention ||
          t.name === `@${username}`
        )
      )

      console.log('[AP Inbox] Mention check result:', { isMentioned })

      if (isMentioned) {
        // Fetch remote actor info
        const remoteActorUri = activity.actor
        let actorName = remoteActorUri
        let actorAvatarUrl: string | null = null
        let remoteActorUrl: string | null = remoteActorUri

        if (remoteActorUri) {
          const remoteActor = await fetchActor(remoteActorUri)
          if (remoteActor) {
            actorName = remoteActor.name || remoteActor.preferredUsername || remoteActorUri
            actorAvatarUrl = remoteActor.icon?.url || null
            remoteActorUrl = remoteActor.url || remoteActorUri
          }
        }

        // Extract content summary
        const noteContent = noteObject.content || ''
        const contentSummary = truncate(stripHtml(noteContent), 200)
        const noteUrl = noteObject.url || noteObject.id || null

        await createNotification(db, {
          userId: user.id,
          type: 'mention',
          actorName,
          actorAvatarUrl,
          actorUrl: remoteActorUrl,
          actorUri: remoteActorUri,
          metadata: JSON.stringify({ content: contentSummary, noteUrl }),
        })
      }
    }
    return c.json({ status: 'accepted' }, 202)
  }

  // Unknown activity type — accept silently
  return c.json({ status: 'accepted' }, 202)
})

// --- Shared Inbox (for receiving activities addressed to any local user) ---
ap.post('/ap/inbox', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const host = new URL(baseUrl).host

  let activity: Record<string, any>
  try {
    activity = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  console.log('[AP SharedInbox] Received activity:', {
    type: activity.type,
    actor: activity.actor,
    objectType: activity.object?.type,
  })

  const type = activity.type

  if (type === 'Create') {
    const noteObject = typeof activity.object === 'object' ? activity.object : null
    if (noteObject?.type === 'Note') {
      const tags = Array.isArray(noteObject.tag) ? noteObject.tag : []

      console.log('[AP SharedInbox] Create(Note) tags:', JSON.stringify(tags))

      // Find all local users mentioned in this note
      for (const tag of tags) {
        if (tag.type !== 'Mention') continue

        // Try to extract username from mention
        let mentionedUsername: string | null = null
        let isGroupMention = false

        // Check if href points to our domain - could be user or group
        if (tag.href && typeof tag.href === 'string') {
          const userHrefMatch = tag.href.match(new RegExp(`^${baseUrl}/ap/users/([^/]+)$`))
          if (userHrefMatch) {
            mentionedUsername = userHrefMatch[1]
          }
          const groupHrefMatch = tag.href.match(new RegExp(`^${baseUrl}/ap/groups/([^/]+)$`))
          if (groupHrefMatch) {
            mentionedUsername = groupHrefMatch[1]
            isGroupMention = true
          }
        }

        // Or check name like @username@domain or @username
        if (!mentionedUsername && tag.name && typeof tag.name === 'string') {
          const nameMatch = tag.name.match(/^@([^@]+)(?:@(.+))?$/)
          if (nameMatch) {
            const [, username, domain] = nameMatch
            if (!domain || domain === host) {
              mentionedUsername = username
            }
          }
        }

        if (!mentionedUsername) continue

        console.log('[AP SharedInbox] Found mention:', { mentionedUsername, isGroupMention })

        // Check if it's a group mention
        if (isGroupMention || !await findUserByApUsername(db, mentionedUsername)) {
          // Try to find as group
          const groupResult = await db.select()
            .from(groups)
            .where(eq(groups.actorName, mentionedUsername))
            .limit(1)

          if (groupResult.length > 0 && groupResult[0].actorName) {
            const group = groupResult[0]
            const remoteActorUri = activity.actor
            const remoteActor = await fetchActor(remoteActorUri)
            const actorName = remoteActor?.preferredUsername || 'fediverse_user'

            // Get or create local user for the remote actor
            const author = await getOrCreateRemoteUser(db, remoteActorUri, remoteActor)
            const userId = author ? author.id : group.creatorId

            const noteContent = noteObject.content || ''
            const inReplyTo = noteObject.inReplyTo as string | undefined
            const noteId = noteObject.id

            // Check if this is a reply to an existing topic
            if (inReplyTo) {
              let topicId: string | null = null
              let replyToCommentId: string | null = null

              // 1. Check if reply to local topic URL
              const topicMatch = inReplyTo.match(/\/topic\/([a-zA-Z0-9_-]+)/)
              if (topicMatch) {
                topicId = topicMatch[1]
              } else {
                // 2. Check if reply to known Fediverse object (Topic)
                const parentTopic = await db.select({ id: topics.id })
                  .from(topics)
                  .where(eq(topics.mastodonStatusId, inReplyTo))
                  .limit(1)

                if (parentTopic.length > 0) {
                  topicId = parentTopic[0].id
                } else {
                  // 3. Check if reply to known Fediverse object (Comment)
                  const parentComment = await db.select({ id: comments.id, topicId: comments.topicId })
                    .from(comments)
                    .where(eq(comments.mastodonStatusId, inReplyTo))
                    .limit(1)

                  if (parentComment.length > 0) {
                    topicId = parentComment[0].topicId
                    replyToCommentId = parentComment[0].id
                  }
                }
              }

              if (topicId) {
                // Verify topic exists
                const topicResult = await db.select({ id: topics.id })
                  .from(topics)
                  .where(eq(topics.id, topicId))
                  .limit(1)

                if (topicResult.length > 0) {
                  // Create comment from reply
                  const commentId = generateId()
                  const commentNow = new Date()
                  const htmlContent = noteContent

                  await db.insert(comments).values({
                    id: commentId,
                    topicId,
                    userId: userId,
                    content: htmlContent,
                    replyToId: replyToCommentId,
                    mastodonStatusId: noteId,
                    mastodonDomain: 'activitypub_origin',
                    createdAt: commentNow,
                    updatedAt: commentNow,
                  })

                  await db.update(topics).set({ updatedAt: commentNow }).where(eq(topics.id, topicId))
                  console.log('[AP SharedInbox] Created comment from reply:', { commentId, topicId, actorName, userId, inReplyTo })
                  continue
                }
              }
            }

            // Not a reply - create new topic
            console.log('[AP SharedInbox] Creating topic from group mention:', mentionedUsername)
            const textContent = stripHtml(noteContent)
            const cleanedText = textContent.replace(/@[^\s]+/g, '').trim()
            const title = truncate(cleanedText.split('\n')[0] || 'Fediverse 帖子', 100)

            const topicId = generateId()
            const topicNow = new Date()

            await db.insert(topics).values({
              id: topicId,
              groupId: group.id,
              userId: userId,
              title: title,
              content: noteContent,
              type: 1,
              mastodonStatusId: noteId,
              mastodonDomain: 'activitypub_origin',
              createdAt: topicNow,
              updatedAt: topicNow,
            })

            console.log('[AP SharedInbox] Created topic from mention:', { topicId, groupId: group.id })

            // Announce (Boost) to group followers
            c.executionCtx.waitUntil(
              boostToGroupFollowers(db, group.actorName!, noteId, baseUrl)
            )

            continue
          }
        }

        // Find the user for user mention
        const user = await findUserByApUsername(db, mentionedUsername)
        if (!user) {
          console.log('[AP SharedInbox] User not found:', mentionedUsername)
          continue
        }

        // Fetch remote actor info
        const remoteActorUri = activity.actor
        let actorName = remoteActorUri
        let actorAvatarUrl: string | null = null
        let remoteActorUrl: string | null = remoteActorUri

        if (remoteActorUri) {
          const remoteActor = await fetchActor(remoteActorUri)
          if (remoteActor) {
            actorName = remoteActor.name || remoteActor.preferredUsername || remoteActorUri
            actorAvatarUrl = remoteActor.icon?.url || null
            remoteActorUrl = remoteActor.url || remoteActorUri
          }
        }

        // Extract content summary
        const noteContent = noteObject.content || ''
        const contentSummary = truncate(stripHtml(noteContent), 200)
        const noteUrl = noteObject.url || noteObject.id || null

        await createNotification(db, {
          userId: user.id,
          type: 'mention',
          actorName,
          actorAvatarUrl,
          actorUrl: remoteActorUrl,
          actorUri: remoteActorUri,
          metadata: JSON.stringify({ content: contentSummary, noteUrl }),
        })

        console.log('[AP SharedInbox] Created notification for user:', user.id)
      }
    }
    return c.json({ status: 'accepted' }, 202)
  }

  // For other activity types, accept silently
  return c.json({ status: 'accepted' }, 202)
})

// --- Followers Collection ---
ap.get('/ap/users/:username/followers', async (c) => {
  const username = c.req.param('username')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const user = await findUserByApUsername(db, username)
  if (!user) {
    return c.notFound()
  }

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(apFollowers)
    .where(eq(apFollowers.userId, user.id))

  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/ap/users/${username}/followers`,
    type: 'OrderedCollection',
    totalItems: countResult[0]?.count || 0,
  }, 200, {
    'Content-Type': 'application/activity+json',
  })
})

// --- Outbox ---
ap.get('/ap/users/:username/outbox', async (c) => {
  const username = c.req.param('username')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const user = await findUserByApUsername(db, username)
  if (!user) {
    return c.notFound()
  }

  const topicCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(topics)
    .where(eq(topics.userId, user.id))

  const commentCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(comments)
    .where(eq(comments.userId, user.id))

  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/ap/users/${username}/outbox`,
    type: 'OrderedCollection',
    totalItems: (topicCount[0]?.count || 0) + (commentCount[0]?.count || 0),
  }, 200, {
    'Content-Type': 'application/activity+json',
  })
})

// --- Note object ---
ap.get('/ap/notes/:topicId', async (c) => {
  const topicId = c.req.param('topicId')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const note = await getNoteJson(db, baseUrl, topicId)
  if (!note) {
    return c.notFound()
  }

  return c.json(note, 200, {
    'Content-Type': 'application/activity+json',
  })
})

// --- Comment Note object ---
ap.get('/ap/comments/:commentId', async (c) => {
  const commentId = c.req.param('commentId')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const note = await getCommentNoteJson(db, baseUrl, commentId)
  if (!note) {
    return c.notFound()
  }

  return c.json(note, 200, {
    'Content-Type': 'application/activity+json',
  })
})

// --- Backfill: push all existing topics to followers ---
ap.post('/ap/users/:username/backfill', async (c) => {
  const username = c.req.param('username')
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Only allow logged-in user to backfill their own account
  const currentUser = c.get('user')
  const user = await findUserByApUsername(db, username)
  if (!user || !currentUser || currentUser.id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const followers = await db
    .select()
    .from(apFollowers)
    .where(eq(apFollowers.userId, user.id))

  if (followers.length === 0) {
    return c.json({ message: 'No followers', delivered: 0 })
  }

  const userTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      createdAt: topics.createdAt,
    })
    .from(topics)
    .where(eq(topics.userId, user.id))
    .orderBy(topics.createdAt)

  if (userTopics.length === 0) {
    return c.json({ message: 'No topics', delivered: 0 })
  }

  const { privateKeyPem } = await ensureKeyPair(db, user.id)
  const actorUrl = `${baseUrl}/ap/users/${username}`

  // Deduplicate inboxes
  const inboxes = new Set<string>()
  for (const f of followers) {
    inboxes.add(f.sharedInboxUrl || f.inboxUrl)
  }

  c.executionCtx.waitUntil((async () => {
    for (const topic of userTopics) {
      const noteId = `${baseUrl}/ap/notes/${topic.id}`
      const topicUrl = `${baseUrl}/topic/${topic.id}`
      const published = topic.createdAt.toISOString()

      let noteContent = `<p><b>${escapeHtml(topic.title)}</b></p>`
      if (topic.content) {
        noteContent += topic.content
      }
      noteContent += `<p><a href="${topicUrl}">${topicUrl}</a></p>`

      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${noteId}/activity`,
        type: 'Create',
        actor: actorUrl,
        published,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actorUrl}/followers`],
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: actorUrl,
          content: noteContent,
          url: topicUrl,
          published,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${actorUrl}/followers`],
        },
      }

      for (const inbox of inboxes) {
        try {
          await signAndDeliver(actorUrl, privateKeyPem, inbox, activity)
        } catch (e) {
          console.error(`Backfill deliver to ${inbox} failed:`, e)
        }
      }
    }
    console.log(`Backfill done: ${userTopics.length} topics to ${inboxes.size} inboxes`)
  })())

  return c.json({ message: 'Backfill started', topics: userTopics.length, inboxes: inboxes.size })
})

// --- NodeInfo ---
ap.get('/.well-known/nodeinfo', async (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  return c.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: `${baseUrl}/nodeinfo/2.0`,
      },
    ],
  })
})

ap.get('/nodeinfo/2.0', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const result = await db.select({ count: sql<number>`count(*)` }).from(users)
  const userCount = result[0]?.count || 0

  return c.json(getNodeInfoJson(baseUrl, userCount), 200, {
    'Content-Type': 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"',
  })
})

export default ap
