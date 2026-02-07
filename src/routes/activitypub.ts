import { Hono } from 'hono'
import { eq, desc, sql, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { authProviders, users, apFollowers, topics } from '../db/schema'
import { generateId } from '../lib/utils'
import {
  ensureKeyPair, getWebFingerJson, getActorJson, getNodeInfoJson,
  fetchActor, signAndDeliver, getNoteJson, getApUsername
} from '../services/activitypub'

const ap = new Hono<AppContext>()

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Resolve a Mastodon username to the earliest-registered user.
 * Username is stored in authProviders.metadata JSON as "username" field.
 * If multiple users share the same Mastodon username, the earliest registered wins.
 */
async function findUserByApUsername(db: ReturnType<typeof import('../db').createDb>, username: string) {
  // Use SQLite json_extract to match username in metadata JSON
  const providers = await db
    .select({
      userId: authProviders.userId,
      createdAt: authProviders.createdAt,
    })
    .from(authProviders)
    .where(sql`json_extract(${authProviders.metadata}, '$.username') = ${username} COLLATE NOCASE`)
    .orderBy(authProviders.createdAt)
    .limit(1)

  if (providers.length === 0) return null

  const userResult = await db
    .select()
    .from(users)
    .where(eq(users.id, providers[0].userId))
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
  const user = await findUserByApUsername(db, username)

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json(getWebFingerJson(username, user.id, baseUrl), 200, {
    'Content-Type': 'application/jrd+json',
    'Access-Control-Allow-Origin': '*',
  })
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

  // Unknown activity type — accept silently
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

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(topics)
    .where(eq(topics.userId, user.id))

  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/ap/users/${username}/outbox`,
    type: 'OrderedCollection',
    totalItems: countResult[0]?.count || 0,
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
