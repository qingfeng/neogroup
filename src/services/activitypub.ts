import { eq, sql, and } from 'drizzle-orm'
import { users, authProviders, apFollowers, topics, comments, groups, groupFollowers, remoteGroups } from '../db/schema'
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
        href: `${baseUrl}/user/${username}`,
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

  const domain = new URL(baseUrl).host

  const actor: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
      {
        toot: 'http://joinmastodon.org/ns#',
        attributionDomains: {
          '@id': 'toot:attributionDomains',
          '@type': '@id',
        },
      },
    ],
    id: actorUrl,
    type: 'Person',
    preferredUsername: apUsername,
    name: user.displayName || user.username,
    url: `${baseUrl}/user/${apUsername}`,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    attributionDomains: [domain],
    endpoints: {
      sharedInbox: `${baseUrl}/ap/inbox`,
    },
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

// --- Group Actor Functions (FEP-1b12) ---

export function getGroupWebFingerJson(actorName: string, groupId: string, baseUrl: string) {
  return {
    subject: `acct:${actorName}@${new URL(baseUrl).host}`,
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `${baseUrl}/ap/groups/${actorName}`,
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${baseUrl}/group/${groupId}`,
      },
    ],
  }
}

export function getGroupActorJson(
  group: { id: string; name: string; actorName: string; description: string | null; iconUrl: string | null },
  publicKeyPem: string,
  baseUrl: string,
  moderatorActorUrls?: string[]
) {
  const actorUrl = `${baseUrl}/ap/groups/${group.actorName}`

  const actor: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: actorUrl,
    type: 'Group',
    preferredUsername: group.actorName,
    name: group.name,
    url: `${baseUrl}/group/${group.id}`,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    endpoints: {
      sharedInbox: `${baseUrl}/ap/inbox`,
    },
    publicKey: {
      id: `${actorUrl}#main-key`,
      owner: actorUrl,
      publicKeyPem,
    },
  }

  if (group.description) {
    actor.summary = group.description
  }

  if (group.iconUrl) {
    actor.icon = {
      type: 'Image',
      mediaType: 'image/png',
      url: group.iconUrl,
    }
  }

  if (moderatorActorUrls && moderatorActorUrls.length > 0) {
    actor.attributedTo = moderatorActorUrls
  }

  actor.attachment = [
    {
      type: 'PropertyValue',
      name: 'Group',
      value: `<a href=\"${baseUrl}/group/${group.id}\">访问小组</a>`,
    },
  ]

  return actor
}

export async function ensureGroupKeyPair(db: Database, groupId: string): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const group = await db.select({ apPublicKey: groups.apPublicKey, apPrivateKey: groups.apPrivateKey })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (group.length > 0 && group[0].apPublicKey && group[0].apPrivateKey) {
    return { publicKeyPem: group[0].apPublicKey, privateKeyPem: group[0].apPrivateKey }
  }

  const { publicKeyPem, privateKeyPem } = await generateKeyPair()

  await db.update(groups).set({
    apPublicKey: publicKeyPem,
    apPrivateKey: privateKeyPem,
  }).where(eq(groups.id, groupId))

  return { publicKeyPem, privateKeyPem }
}

// Announce a Note to all group followers
export async function announceToGroupFollowers(
  db: Database,
  groupId: string,
  groupActorName: string,
  noteObject: Record<string, unknown>,
  baseUrl: string
): Promise<void> {
  // Get group's private key
  const groupData = await db.select({ apPrivateKey: groups.apPrivateKey })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupData.length === 0 || !groupData[0].apPrivateKey) {
    console.log('[AP Announce] Group has no private key:', groupId)
    return
  }

  const privateKeyPem = groupData[0].apPrivateKey
  const groupActorUrl = `${baseUrl}/ap/groups/${groupActorName}`

  // Get all followers
  const followers = await db.select({
    actorUri: groupFollowers.actorUri,
    actorInbox: groupFollowers.actorInbox,
    actorSharedInbox: groupFollowers.actorSharedInbox,
  })
    .from(groupFollowers)
    .where(eq(groupFollowers.groupId, groupId))

  if (followers.length === 0) {
    console.log('[AP Announce] No followers for group:', groupActorName)
    return
  }

  // Create Announce activity
  const announce = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${groupActorUrl}#announce-${Date.now()}`,
    type: 'Announce',
    actor: groupActorUrl,
    audience: groupActorUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${groupActorUrl}/followers`],
    object: noteObject,
  }

  // Dedupe by shared inbox when available
  const inboxes = new Set<string>()
  for (const follower of followers) {
    const inbox = follower.actorSharedInbox || follower.actorInbox
    if (inbox) {
      inboxes.add(inbox)
    }
  }

  console.log('[AP Announce] Broadcasting to', inboxes.size, 'inboxes for group:', groupActorName)

  // Deliver to each unique inbox
  const deliveryPromises = Array.from(inboxes).map(inbox =>
    signAndDeliver(groupActorUrl, privateKeyPem, inbox, announce)
      .catch(e => console.error('[AP Announce] Delivery failed to', inbox, e))
  )

  await Promise.allSettled(deliveryPromises)
}

// Announce a Note to all user's AP followers (for repost/boost)
export async function announceToUserFollowers(
  db: Database,
  baseUrl: string,
  userId: string,
  topicId: string
): Promise<void> {
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

  const announce = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl}#announce-${Date.now()}`,
    type: 'Announce',
    actor: actorUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${actorUrl}/followers`],
    object: noteId,
  }

  // Deduplicate by sharedInbox
  const inboxes = new Set<string>()
  for (const f of followers) {
    inboxes.add(f.sharedInboxUrl || f.inboxUrl)
  }

  console.log('[AP Announce] User', apUsername, 'broadcasting to', inboxes.size, 'inboxes')

  const promises = Array.from(inboxes).map(inbox =>
    signAndDeliver(actorUrl, privateKeyPem, inbox, announce)
      .catch(e => console.error('[AP Announce] User deliver failed:', inbox, e))
  )
  await Promise.allSettled(promises)
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

// --- Remote Group Discovery ---

export interface RemoteGroupInfo {
  actorUri: string
  name: string
  description: string | null
  iconUrl: string | null
  inbox: string
  sharedInbox: string | null
  domain: string
  preferredUsername: string
}

export async function discoverRemoteGroup(handle: string): Promise<RemoteGroupInfo | null> {
  // Parse @actorName@domain or actorName@domain
  const match = handle.replace(/^@/, '').match(/^([^@]+)@(.+)$/)
  if (!match) return null

  const [, actorName, domain] = match

  // WebFinger lookup
  try {
    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${actorName}@${domain}`
    const wfRes = await fetch(webfingerUrl, {
      headers: { 'Accept': 'application/jrd+json, application/json' },
    })
    if (!wfRes.ok) return null

    const wfData = await wfRes.json() as any
    const selfLink = wfData.links?.find((l: any) => l.rel === 'self' && l.type === 'application/activity+json')
    if (!selfLink?.href) return null

    // Fetch actor
    const actor = await fetchActor(selfLink.href)
    if (!actor) return null

    // Verify it's a Group type
    if (actor.type !== 'Group') return null

    return {
      actorUri: actor.id,
      name: actor.name || actor.preferredUsername || actorName,
      description: actor.summary ? stripHtml(actor.summary).slice(0, 500) : null,
      iconUrl: actor.icon?.url || null,
      inbox: actor.inbox,
      sharedInbox: actor.endpoints?.sharedInbox || null,
      domain,
      preferredUsername: actor.preferredUsername || actorName,
    }
  } catch (e) {
    console.error('[discoverRemoteGroup] Error:', e)
    return null
  }
}

// --- Remote User Discovery ---

export interface RemoteUserInfo {
  actorUri: string
  name: string
  username: string
  avatarUrl: string | null
  domain: string
}

export async function discoverRemoteUser(handle: string): Promise<RemoteUserInfo | null> {
  // Parse @user@domain or user@domain
  const match = handle.replace(/^@/, '').match(/^([^@]+)@(.+)$/)
  if (!match) return null

  const [, username, domain] = match

  try {
    const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`
    const wfRes = await fetch(webfingerUrl, {
      headers: { 'Accept': 'application/jrd+json, application/json' },
    })
    if (!wfRes.ok) return null

    const wfData = await wfRes.json() as any
    const selfLink = wfData.links?.find((l: any) => l.rel === 'self' && l.type === 'application/activity+json')
    if (!selfLink?.href) return null

    const actor = await fetchActor(selfLink.href)
    if (!actor) return null

    // Accept Person type (or Application/Service for bots)
    if (actor.type !== 'Person' && actor.type !== 'Application' && actor.type !== 'Service') return null

    return {
      actorUri: actor.id,
      name: actor.name || actor.preferredUsername || username,
      username: actor.preferredUsername || username,
      avatarUrl: actor.icon?.url || null,
      domain,
    }
  } catch (e) {
    console.error('[discoverRemoteUser] Error:', e)
    return null
  }
}

// --- AP Username lookup ---

export async function getApUsername(db: Database, userId: string): Promise<string | null> {
  const providers = await db
    .select({ metadata: authProviders.metadata })
    .from(authProviders)
    .where(and(eq(authProviders.userId, userId), eq(authProviders.providerType, 'mastodon')))
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

    // Build note content: title as bold (if present), then content
    let noteContent = ''
    if (title) {
      noteContent += `<p><b>${escapeHtml(title)}</b></p>`
    }
    if (content) {
      noteContent += content
    }
    if (title) {
      noteContent += `<p><a href="${topicUrl}">${topicUrl}</a></p>`
    }

    const note = {
      id: noteId,
      type: 'Note',
      attributedTo: actorUrl,
      context: noteId,
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

  let noteContent = ''
  if (topic.title) {
    noteContent += `<p><b>${escapeHtml(topic.title)}</b></p>`
  }
  if (topic.content) {
    noteContent += topic.content
  }
  if (topic.title) {
    noteContent += `<p><a href="${topicUrl}">${topicUrl}</a></p>`
  }

  const note: Record<string, unknown> = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: noteId,
    type: 'Note',
    attributedTo: actorUrl,
    context: noteId,
    content: noteContent,
    url: topicUrl,
    published: topic.createdAt.toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${actorUrl}/followers`],
  }
  if (topic.title) {
    note.name = topic.title
  }
  return note
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
    context: `${baseUrl}/ap/notes/${comment.topicId}`,
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
      context: `${baseUrl}/ap/notes/${topicId}`,
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

export async function getOrCreateRemoteUser(db: Database, actorUri: string, actorData?: any): Promise<typeof users.$inferSelect | undefined> {
  const preferredUsername = actorData?.preferredUsername || actorData?.name || extractUsername(actorUri)
  let actorDomain: string | null = null
  try { actorDomain = new URL(actorUri).host } catch { /* ignore */ }

  // 1) existing activitypub mapping
  const existingAuth = await db.select()
    .from(authProviders)
    .where(and(eq(authProviders.providerType, 'activitypub'), eq(authProviders.providerId, actorUri)))
    .limit(1)
  if (existingAuth.length > 0) {
    const userResult = await db.select().from(users).where(eq(users.id, existingAuth[0].userId)).limit(1)
    if (userResult.length > 0) return userResult[0]
  }

  // 2) match by users.username (username@domain)
  if (preferredUsername && actorDomain) {
    const candidateUsername = `${preferredUsername}@${actorDomain}`
    const userMatch = await db.select().from(users).where(eq(users.username, candidateUsername)).limit(1)
    if (userMatch.length > 0) return userMatch[0]
  }

  // 3) match existing mastodon auth provider with same domain+username
  if (preferredUsername && actorDomain) {
    const mastodonAuth = await db.select({ userId: authProviders.userId, metadata: authProviders.metadata, providerId: authProviders.providerId })
      .from(authProviders)
      .where(eq(authProviders.providerType, 'mastodon'))
      .limit(200) // small scan

    for (const auth of mastodonAuth) {
      try {
        const meta = auth.metadata ? JSON.parse(auth.metadata) as { username?: string } : {}
        const domain = auth.providerId.split('@')[1]
        if (domain === actorDomain && meta.username === preferredUsername) {
          const userResult = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1)
          if (userResult.length > 0) return userResult[0]
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 2. Create new user
  let username = ''
  let displayName = ''
  let avatarUrl = ''

  if (actorData) {
    const preferredUsername = actorData.preferredUsername || 'user'
    let domain = 'fediverse'
    try {
      const url = new URL(actorUri)
      domain = url.host
    } catch (e) {
      // ignore
    }
    username = `${preferredUsername}@${domain}`
    displayName = actorData.name || preferredUsername
    if (actorData.icon && actorData.icon.url) {
      avatarUrl = actorData.icon.url
    }
  } else {
    username = `ap_user_${Date.now()}`
    displayName = 'Fediverse User'
  }

  // Check username uniqueness and append suffix if needed
  let finalUsername = username
  let retryCount = 0

  while (true) {
    const existingUser = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.username, finalUsername))
      .limit(1)

    if (existingUser.length === 0) break

    retryCount++
    if (retryCount > 10) {
      finalUsername = `${username}_${crypto.randomUUID().slice(0, 8)}`
      break
    }
    finalUsername = `${username}_${retryCount}`
  }

  const userId = crypto.randomUUID()
  const now = new Date()

  try {
    await db.insert(users).values({
      id: userId,
      username: finalUsername,
      displayName: displayName || finalUsername,
      avatarUrl,
      bio: actorData?.summary ? stripHtml(actorData.summary).slice(0, 200) : null,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(authProviders).values({
      id: crypto.randomUUID(),
      userId,
      providerType: 'activitypub',
      providerId: actorUri,
      metadata: actorData ? JSON.stringify(actorData) : null,
      createdAt: now,
    })

    return {
      id: userId,
      username: finalUsername,
      displayName: displayName || finalUsername,
      avatarUrl,
      bio: actorData?.summary ? stripHtml(actorData.summary).slice(0, 200) : null,
      role: null,
      apPublicKey: null,
      apPrivateKey: null,
      createdAt: now,
      updatedAt: now,
    }
  } catch (e) {
    console.error('Failed to create remote user:', e)
    return undefined
  }
}

// Helper to strip HTML
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>?/gm, '')
}

export async function boostToGroupFollowers(
  db: Database,
  groupActorName: string,
  noteId: string,
  baseUrl: string
) {
  try {
    // 1. Get group info (keys, id)
    const groupResult = await db.select({
      id: groups.id,
      apPublicKey: groups.apPublicKey,
      apPrivateKey: groups.apPrivateKey
    })
      .from(groups)
      .where(eq(groups.actorName, groupActorName))
      .limit(1)

    if (groupResult.length === 0) return
    const group = groupResult[0]

    // Ensure keys
    let privateKeyPem = group.apPrivateKey
    if (!group.apPublicKey || !group.apPrivateKey) {
      const keys = await ensureGroupKeyPair(db, group.id)
      privateKeyPem = keys.privateKeyPem
    }
    if (!privateKeyPem) return

    // 2. Get followers
    const followers = await db.select()
      .from(groupFollowers)
      .where(eq(groupFollowers.groupId, group.id))

    if (followers.length === 0) {
      console.log('[AP Boost] No followers to boost to')
      return
    }

    // 3. Construct Announce Activity
    const actorUrl = `${baseUrl}/ap/groups/${groupActorName}`
    // Use a deterministic ID for boost? or random? Random is fine.
    const announceId = `${baseUrl}/ap/announce/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const now = new Date().toISOString()

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: announceId,
      type: 'Announce',
      actor: actorUrl,
      audience: actorUrl,
      published: now,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorUrl}/followers`],
      object: noteId,
    }

    // Also try to deliver directly to the original note's actor inbox so origin instance sees the Announce
    try {
      const resp = await fetch(noteId, { headers: { Accept: 'application/activity+json' } })
      if (resp.ok) {
        const note = await resp.json()
        const attributed = Array.isArray(note.attributedTo) ? note.attributedTo[0] : note.attributedTo
        const targetActorId = typeof attributed === 'string' ? attributed : (typeof note.actor === 'string' ? note.actor : null)
        if (targetActorId) {
          const remoteActor = await fetchActor(targetActorId)
          const targetInbox = remoteActor?.endpoints?.sharedInbox || remoteActor?.inbox
          if (targetInbox) {
            followers.push({
              actorUri: targetActorId,
              actorInbox: remoteActor?.inbox || null,
              actorSharedInbox: remoteActor?.endpoints?.sharedInbox || null,
            } as any)
          }
        }
      }
    } catch (e) {
      console.error('[AP Boost] fetch target note failed', e)
    }

    // 4. Deliver
    const inboxes = new Map<string, string>()
    for (const f of followers) {
      const inbox = f.actorSharedInbox || f.actorInbox
      if (inbox && !inboxes.has(inbox)) {
        inboxes.set(inbox, inbox)
      }
    }

    console.log(`[AP Boost] Boosting ${noteId} to ${inboxes.size} inboxes`)

    for (const inbox of inboxes.values()) {
      try {
        await signAndDeliver(actorUrl, privateKeyPem, inbox, activity)
      } catch (e) {
        console.error(`AP boost deliver to ${inbox} failed:`, e)
      }
    }

    // Persist to group outbox
    try {
      await db.insert(groupActivities).values({
        id: generateId(),
        groupId: group.id,
        activityJson: JSON.stringify(activity),
        createdAt: new Date(),
      })
    } catch (e) {
      console.error('[AP Boost] failed to persist activity', e)
    }

  } catch (e) {
    console.error('boostToGroupFollowers error:', e)
  }
}
