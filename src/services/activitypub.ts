import { eq, sql } from 'drizzle-orm'
import { users, authProviders, apFollowers, topics, comments } from '../db/schema'
import type { Database } from '../db'

// --- Key Pair Generation (Web Crypto API) ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function formatPem(base64: string, type: 'PUBLIC' | 'PRIVATE'): string {
  const lines = base64.match(/.{1,64}/g) || []
  return `-----BEGIN ${type} KEY-----\n${lines.join('\n')}\n-----END ${type} KEY-----`
}

export async function generateKeyPair(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )

  const pair = keyPair as CryptoKeyPair
  const publicKeyBuffer = await crypto.subtle.exportKey('spki', pair.publicKey) as ArrayBuffer
  const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer

  const publicKeyPem = formatPem(arrayBufferToBase64(publicKeyBuffer), 'PUBLIC')
  const privateKeyPem = formatPem(arrayBufferToBase64(privateKeyBuffer), 'PRIVATE')

  return { publicKeyPem, privateKeyPem }
}

export async function ensureKeyPair(db: Database, userId: string): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const user = await db.select({ apPublicKey: users.apPublicKey, apPrivateKey: users.apPrivateKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (user.length > 0 && user[0].apPublicKey && user[0].apPrivateKey) {
    return { publicKeyPem: user[0].apPublicKey, privateKeyPem: user[0].apPrivateKey }
  }

  const { publicKeyPem, privateKeyPem } = await generateKeyPair()

  await db.update(users).set({
    apPublicKey: publicKeyPem,
    apPrivateKey: privateKeyPem,
  }).where(eq(users.id, userId))

  return { publicKeyPem, privateKeyPem }
}

// --- JSON-LD Construction ---

export function getWebFingerJson(username: string, userId: string, baseUrl: string) {
  return {
    subject: `acct:${username}@${new URL(baseUrl).host}`,
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `${baseUrl}/ap/users/${username}`,
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${baseUrl}/user/${userId}`,
      },
    ],
  }
}

export function getActorJson(
  user: { id: string; displayName: string | null; username: string; bio: string | null; avatarUrl: string | null },
  apUsername: string,
  publicKeyPem: string,
  baseUrl: string
) {
  const actorUrl = `${baseUrl}/ap/users/${apUsername}`

  const actor: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: actorUrl,
    type: 'Person',
    preferredUsername: apUsername,
    name: user.displayName || user.username,
    url: `${baseUrl}/user/${user.id}`,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    publicKey: {
      id: `${actorUrl}#main-key`,
      owner: actorUrl,
      publicKeyPem,
    },
  }

  if (user.bio) {
    actor.summary = user.bio
  }

  if (user.avatarUrl) {
    actor.icon = {
      type: 'Image',
      mediaType: 'image/png',
      url: user.avatarUrl,
    }
  }

  return actor
}

export function getNodeInfoJson(baseUrl: string, userCount: number) {
  return {
    version: '2.0',
    software: {
      name: 'neogroup',
      version: '1.0.0',
    },
    protocols: ['activitypub'],
    usage: {
      users: {
        total: userCount,
      },
      localPosts: 0,
    },
    openRegistrations: false,
  }
}

// --- HTTP Signatures (draft-cavage, Mastodon compatible) ---

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const der = base64ToArrayBuffer(base64)
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

export async function signAndDeliver(
  actorUrl: string,
  privateKeyPem: string,
  targetInbox: string,
  activity: Record<string, unknown>
): Promise<Response> {
  const body = JSON.stringify(activity)
  const digestBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const digestBase64 = arrayBufferToBase64(digestBuffer)
  const digest = `SHA-256=${digestBase64}`

  const url = new URL(targetInbox)
  const date = new Date().toUTCString()

  const signedString = [
    `(request-target): post ${url.pathname}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: application/activity+json`,
  ].join('\n')

  const privateKey = await importPrivateKey(privateKeyPem)
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signedString)
  )
  const signatureBase64 = arrayBufferToBase64(signatureBuffer)

  const signatureHeader = [
    `keyId="${actorUrl}#main-key"`,
    `headers="(request-target) host date digest content-type"`,
    `signature="${signatureBase64}"`,
    `algorithm="rsa-sha256"`,
  ].join(',')

  return fetch(targetInbox, {
    method: 'POST',
    headers: {
      'Host': url.host,
      'Date': date,
      'Digest': digest,
      'Content-Type': 'application/activity+json',
      'Signature': signatureHeader,
      'Accept': 'application/activity+json',
    },
    body,
  })
}

export async function fetchActor(actorUri: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(actorUri, {
      headers: { 'Accept': 'application/activity+json, application/ld+json' },
    })
    if (!res.ok) return null
    return await res.json() as Record<string, any>
  } catch {
    return null
  }
}

// --- AP Username lookup ---

export async function getApUsername(db: Database, userId: string): Promise<string | null> {
  const providers = await db
    .select({ metadata: authProviders.metadata })
    .from(authProviders)
    .where(eq(authProviders.userId, userId))
    .limit(1)

  if (providers.length === 0 || !providers[0].metadata) return null

  try {
    const meta = JSON.parse(providers[0].metadata)
    return meta.username || null
  } catch {
    return null
  }
}

// --- Topic delivery to AP followers ---

export async function deliverTopicToFollowers(
  db: Database,
  baseUrl: string,
  userId: string,
  topicId: string,
  title: string,
  content: string | null
) {
  try {
    const apUsername = await getApUsername(db, userId)
    if (!apUsername) return

    const { privateKeyPem } = await ensureKeyPair(db, userId)

    const followers = await db
      .select()
      .from(apFollowers)
      .where(eq(apFollowers.userId, userId))

    if (followers.length === 0) return

    const actorUrl = `${baseUrl}/ap/users/${apUsername}`
    const noteId = `${baseUrl}/ap/notes/${topicId}`
    const topicUrl = `${baseUrl}/topic/${topicId}`
    const published = new Date().toISOString()

    // Build note content: title as bold, then content
    let noteContent = `<p><b>${escapeHtml(title)}</b></p>`
    if (content) {
      noteContent += content
    }
    noteContent += `<p><a href="${topicUrl}">${topicUrl}</a></p>`

    const note = {
      id: noteId,
      type: 'Note',
      attributedTo: actorUrl,
      content: noteContent,
      url: topicUrl,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorUrl}/followers`],
    }

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${noteId}/activity`,
      type: 'Create',
      actor: actorUrl,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorUrl}/followers`],
      object: note,
    }

    // Deduplicate by sharedInbox
    const inboxes = new Map<string, string>()
    for (const f of followers) {
      const inbox = f.sharedInboxUrl || f.inboxUrl
      if (!inboxes.has(inbox)) {
        inboxes.set(inbox, inbox)
      }
    }

    for (const inbox of inboxes.values()) {
      try {
        await signAndDeliver(actorUrl, privateKeyPem, inbox, activity)
      } catch (e) {
        console.error(`AP deliver to ${inbox} failed:`, e)
      }
    }
  } catch (e) {
    console.error('deliverTopicToFollowers error:', e)
  }
}

// --- Note JSON-LD ---

export async function getNoteJson(
  db: Database,
  baseUrl: string,
  topicId: string
): Promise<Record<string, unknown> | null> {
  const topicResult = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      userId: topics.userId,
      createdAt: topics.createdAt,
    })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) return null

  const topic = topicResult[0]
  const apUsername = await getApUsername(db, topic.userId)
  if (!apUsername) return null

  const actorUrl = `${baseUrl}/ap/users/${apUsername}`
  const noteId = `${baseUrl}/ap/notes/${topicId}`
  const topicUrl = `${baseUrl}/topic/${topicId}`

  let noteContent = `<p><b>${escapeHtml(topic.title)}</b></p>`
  if (topic.content) {
    noteContent += topic.content
  }
  noteContent += `<p><a href="${topicUrl}">${topicUrl}</a></p>`

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: noteId,
    type: 'Note',
    attributedTo: actorUrl,
    content: noteContent,
    url: topicUrl,
    published: topic.createdAt.toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${actorUrl}/followers`],
  }
}

// --- Comment Note JSON-LD ---

export async function getCommentNoteJson(
  db: Database,
  baseUrl: string,
  commentId: string
): Promise<Record<string, unknown> | null> {
  const commentResult = await db
    .select({
      id: comments.id,
      topicId: comments.topicId,
      userId: comments.userId,
      content: comments.content,
      replyToId: comments.replyToId,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) return null

  const comment = commentResult[0]
  const apUsername = await getApUsername(db, comment.userId)
  if (!apUsername) return null

  const actorUrl = `${baseUrl}/ap/users/${apUsername}`
  const noteId = `${baseUrl}/ap/comments/${commentId}`
  const commentUrl = `${baseUrl}/topic/${comment.topicId}#comment-${commentId}`

  // inReplyTo: reply to parent comment or parent topic
  let inReplyTo: string
  if (comment.replyToId) {
    inReplyTo = `${baseUrl}/ap/comments/${comment.replyToId}`
  } else {
    inReplyTo = `${baseUrl}/ap/notes/${comment.topicId}`
  }

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: noteId,
    type: 'Note',
    attributedTo: actorUrl,
    inReplyTo,
    content: comment.content,
    url: commentUrl,
    published: comment.createdAt.toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${actorUrl}/followers`],
  }
}

// --- Comment delivery to AP followers ---

export async function deliverCommentToFollowers(
  db: Database,
  baseUrl: string,
  userId: string,
  commentId: string,
  topicId: string,
  content: string,
  replyToId: string | null
) {
  try {
    const apUsername = await getApUsername(db, userId)
    if (!apUsername) return

    const { privateKeyPem } = await ensureKeyPair(db, userId)

    const followers = await db
      .select()
      .from(apFollowers)
      .where(eq(apFollowers.userId, userId))

    if (followers.length === 0) return

    const actorUrl = `${baseUrl}/ap/users/${apUsername}`
    const noteId = `${baseUrl}/ap/comments/${commentId}`
    const commentUrl = `${baseUrl}/topic/${topicId}#comment-${commentId}`
    const published = new Date().toISOString()

    let inReplyTo: string
    if (replyToId) {
      inReplyTo = `${baseUrl}/ap/comments/${replyToId}`
    } else {
      inReplyTo = `${baseUrl}/ap/notes/${topicId}`
    }

    const note = {
      id: noteId,
      type: 'Note',
      attributedTo: actorUrl,
      inReplyTo,
      content,
      url: commentUrl,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorUrl}/followers`],
    }

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${noteId}/activity`,
      type: 'Create',
      actor: actorUrl,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorUrl}/followers`],
      object: note,
    }

    // Deduplicate by sharedInbox
    const inboxes = new Map<string, string>()
    for (const f of followers) {
      const inbox = f.sharedInboxUrl || f.inboxUrl
      if (!inboxes.has(inbox)) {
        inboxes.set(inbox, inbox)
      }
    }

    for (const inbox of inboxes.values()) {
      try {
        await signAndDeliver(actorUrl, privateKeyPem, inbox, activity)
      } catch (e) {
        console.error(`AP comment deliver to ${inbox} failed:`, e)
      }
    }
  } catch (e) {
    console.error('deliverCommentToFollowers error:', e)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
