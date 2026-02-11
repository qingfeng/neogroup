import { Hono } from 'hono'
import { eq, desc, and, or, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, groups, groupMembers, topics, comments, topicLikes, topicReposts, commentLikes, commentReposts, userFollows, nostrFollows, apFollowers } from '../db/schema'
import { generateId, generateApiKey, ensureUniqueUsername, stripHtml } from '../lib/utils'
import { requireApiAuth } from '../middleware/auth'
import { createNotification } from '../lib/notifications'
import { deliverTopicToFollowers, deliverCommentToFollowers, announceToGroupFollowers, ensureKeyPair, signAndDeliver, getApUsername } from '../services/activitypub'
import { generateNostrKeypair, buildSignedEvent } from '../services/nostr'

const api = new Hono<AppContext>()

// ─── 公开端点：注册 ───

api.post('/auth/register', async (c) => {
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  const name = body.name?.trim()

  if (!name || name.length < 1 || name.length > 50) {
    return c.json({ error: 'name is required (1-50 chars)' }, 400)
  }

  // KV 限流：每 IP 5 分钟 1 次
  const kv = c.env.KV
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  const rateKey = `api_reg:${ip}`
  const existing = await kv.get(rateKey)
  if (existing) {
    return c.json({ error: 'Rate limited. Try again in 5 minutes.' }, 429)
  }
  await kv.put(rateKey, '1', { expirationTtl: 300 })

  // 生成 username（slug 化 name）
  const baseUsername = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'agent'
  const username = await ensureUniqueUsername(db, baseUsername)

  // 生成 API key
  const { key, hash, keyId } = await generateApiKey()

  const userId = generateId()
  const now = new Date()

  // 创建用户
  await db.insert(users).values({
    id: userId,
    username,
    displayName: name,
    createdAt: now,
    updatedAt: now,
  })

  // 创建 authProvider
  await db.insert(authProviders).values({
    id: keyId,
    userId,
    providerType: 'apikey',
    providerId: `apikey:${username}`,
    accessToken: hash,
    createdAt: now,
  })

  // 自动生成 Nostr 密钥并开启同步
  if (c.env.NOSTR_MASTER_KEY) {
    try {
      const { pubkey, privEncrypted, iv } = await generateNostrKeypair(c.env.NOSTR_MASTER_KEY)
      await db.update(users).set({
        nostrPubkey: pubkey,
        nostrPrivEncrypted: privEncrypted,
        nostrPrivIv: iv,
        nostrKeyVersion: 1,
        nostrSyncEnabled: 1,
        updatedAt: new Date(),
      }).where(eq(users.id, userId))

      // 广播 Kind 0 metadata
      if (c.env.NOSTR_QUEUE) {
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const host = new URL(baseUrl).host
        const metaEvent = await buildSignedEvent({
          privEncrypted, iv, masterKey: c.env.NOSTR_MASTER_KEY,
          kind: 0,
          content: JSON.stringify({
            name,
            about: '',
            picture: '',
            nip05: `${username}@${host}`,
            ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
          }),
          tags: [],
        })
        c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [metaEvent] }))
      }
    } catch (e) {
      console.error('[API] Failed to generate Nostr keys:', e)
    }
  }

  return c.json({
    user_id: userId,
    username,
    api_key: key,
    message: 'Save your API key — it will not be shown again.',
  }, 201)
})

// ─── 认证端点 ───

// GET /api/me
api.get('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  return c.json({
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    avatar_url: user.avatarUrl,
    bio: user.bio,
    profile_url: `${baseUrl}/user/${user.id}`,
  })
})

// PUT /api/me
api.put('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { display_name?: string; bio?: string }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.display_name !== undefined) updates.displayName = body.display_name.slice(0, 100)
  if (body.bio !== undefined) updates.bio = body.bio.slice(0, 500)

  await db.update(users).set(updates).where(eq(users.id, user.id))

  // 更新 Nostr Kind 0 if enabled
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    try {
      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      const host = new URL(baseUrl).host
      const metaEvent = await buildSignedEvent({
        privEncrypted: user.nostrPrivEncrypted!,
        iv: user.nostrPrivIv!,
        masterKey: c.env.NOSTR_MASTER_KEY,
        kind: 0,
        content: JSON.stringify({
          name: (body.display_name !== undefined ? body.display_name.slice(0, 100) : user.displayName) || user.username,
          about: body.bio !== undefined ? stripHtml(body.bio.slice(0, 500)) : (user.bio ? stripHtml(user.bio) : ''),
          picture: user.avatarUrl || '',
          nip05: `${user.username}@${host}`,
          ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
        }),
        tags: [],
      })
      c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [metaEvent] }))
    } catch (e) {
      console.error('[API] Failed to update Nostr metadata:', e)
    }
  }

  return c.json({ ok: true })
})

// GET /api/groups
api.get('/groups', requireApiAuth, async (c) => {
  const db = c.get('db')

  const allGroups = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      icon_url: groups.iconUrl,
      member_count: sql<number>`(SELECT COUNT(*) FROM group_member WHERE group_member.group_id = "group".id)`,
      topic_count: sql<number>`(SELECT COUNT(*) FROM topic WHERE topic.group_id = "group".id)`,
    })
    .from(groups)
    .orderBy(desc(groups.updatedAt))

  return c.json({ groups: allGroups })
})

// GET /api/groups/:id/topics
api.get('/groups/:id/topics', requireApiAuth, async (c) => {
  const db = c.get('db')
  const groupId = c.req.param('id')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  // Check group exists
  const group = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1)
  if (group.length === 0) return c.json({ error: 'Group not found' }, 404)

  const topicList = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      created_at: topics.createdAt,
      author: {
        id: users.id,
        username: users.username,
        display_name: users.displayName,
      },
      comment_count: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
      like_count: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.groupId, groupId))
    .orderBy(desc(topics.updatedAt))
    .limit(limit)
    .offset(offset)

  const result = topicList.map(t => ({
    ...t,
    content: t.content ? stripHtml(t.content).slice(0, 300) : null,
  }))

  return c.json({ topics: result, page, limit })
})

// GET /api/topics/:id
api.get('/topics/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const topicId = c.req.param('id')

  const topicResult = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      group_id: topics.groupId,
      created_at: topics.createdAt,
      author: {
        id: users.id,
        username: users.username,
        display_name: users.displayName,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  const topicData = topicResult[0]

  // 获取评论
  const commentList = await db
    .select({
      id: comments.id,
      content: comments.content,
      reply_to_id: comments.replyToId,
      created_at: comments.createdAt,
      author: {
        id: users.id,
        username: users.username,
        display_name: users.displayName,
      },
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.topicId, topicId))
    .orderBy(comments.createdAt)

  return c.json({
    topic: {
      ...topicData,
      content: topicData.content ? stripHtml(topicData.content) : null,
    },
    comments: commentList.map(cm => ({
      ...cm,
      content: cm.content ? stripHtml(cm.content) : null,
    })),
  })
})

// POST /api/groups/:id/topics — 发帖
api.post('/groups/:id/topics', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const groupId = c.req.param('id')

  const body = await c.req.json().catch(() => ({})) as { title?: string; content?: string }
  const title = body.title?.trim()
  const content = body.content?.trim() || null

  if (!title || title.length < 1 || title.length > 200) {
    return c.json({ error: 'title is required (1-200 chars)' }, 400)
  }

  // Check group exists
  const groupData = await db.select({ id: groups.id, actorName: groups.actorName, nostrSyncEnabled: groups.nostrSyncEnabled, nostrPubkey: groups.nostrPubkey })
    .from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupData.length === 0) return c.json({ error: 'Group not found' }, 404)

  // 自动加入小组
  const membership = await db.select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId,
      userId: user.id,
      createdAt: new Date(),
    })
  }

  const topicId = generateId()
  const now = new Date()

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId: user.id,
    title,
    content,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // AP: deliver to followers
  c.executionCtx.waitUntil(
    deliverTopicToFollowers(db, baseUrl, user.id, topicId, title, content)
  )

  // AP: Announce to group followers
  if (groupData[0].actorName) {
    c.executionCtx.waitUntil((async () => {
      const groupActorUrl = `${baseUrl}/ap/groups/${groupData[0].actorName}`
      const topicUrl = `${baseUrl}/topic/${topicId}`
      const noteJson = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: topicUrl,
        type: 'Note',
        attributedTo: groupActorUrl,
        audience: groupActorUrl,
        content: `<p><strong>${title}</strong></p>${content ? `<p>${content}</p>` : ''}<p><a href="${topicUrl}">${topicUrl}</a></p>`,
        url: topicUrl,
        published: new Date().toISOString(),
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${groupActorUrl}/followers`],
      }
      await announceToGroupFollowers(db, groupId, groupData[0].actorName!, noteJson, baseUrl)
    })())
  }

  // Nostr: broadcast Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = content ? stripHtml(content) : ''
        const noteContent = textContent
          ? `${title}\n\n${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}`
          : `${title}\n\n🔗 ${baseUrl}/topic/${topicId}`

        const nostrTags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        // NIP-72 community a-tag
        if (groupData[0].nostrSyncEnabled === 1 && groupData[0].nostrPubkey && groupData[0].actorName) {
          const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
          nostrTags.push(['a', `34550:${groupData[0].nostrPubkey}:${groupData[0].actorName}`, relayUrl])
        }

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags: nostrTags,
        })

        await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish topic:', e)
      }
    })())
  }

  return c.json({
    id: topicId,
    url: `${baseUrl}/topic/${topicId}`,
  }, 201)
})

// POST /api/topics/:id/comments — 评论
api.post('/topics/:id/comments', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const body = await c.req.json().catch(() => ({})) as { content?: string; reply_to_id?: string }
  const content = body.content?.trim()
  const replyToId = body.reply_to_id || null

  if (!content || content.length < 1 || content.length > 5000) {
    return c.json({ error: 'content is required (1-5000 chars)' }, 400)
  }

  // Check topic exists
  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  // Validate reply_to_id
  if (replyToId) {
    const parent = await db.select({ id: comments.id }).from(comments)
      .where(and(eq(comments.id, replyToId), eq(comments.topicId, topicId))).limit(1)
    if (parent.length === 0) return c.json({ error: 'reply_to_id not found in this topic' }, 400)
  }

  const commentId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(comments).values({
    id: commentId,
    topicId,
    userId: user.id,
    content: htmlContent,
    replyToId,
    createdAt: now,
    updatedAt: now,
  })

  // 更新话题 updatedAt
  await db.update(topics).set({ updatedAt: now }).where(eq(topics.id, topicId))

  // 通知话题作者
  await createNotification(db, {
    userId: topicResult[0].userId,
    actorId: user.id,
    type: 'reply',
    topicId,
  })

  // 如果是回复评论，通知该评论作者
  if (replyToId) {
    const replyComment = await db.select({ userId: comments.userId }).from(comments).where(eq(comments.id, replyToId)).limit(1)
    if (replyComment.length > 0 && replyComment[0].userId !== topicResult[0].userId) {
      await createNotification(db, {
        userId: replyComment[0].userId,
        actorId: user.id,
        type: 'comment_reply',
        topicId,
        commentId: replyToId,
      })
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // AP: deliver comment to followers
  c.executionCtx.waitUntil(
    deliverCommentToFollowers(db, baseUrl, user.id, commentId, topicId, htmlContent, replyToId)
  )

  // Nostr: broadcast comment as Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = stripHtml(htmlContent)
        const noteContent = `${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}#comment-${commentId}`

        const tags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        // Thread: root = topic nostr event
        if (topicResult[0].nostrEventId) {
          tags.push(['e', topicResult[0].nostrEventId, '', 'root'])
        }

        // Thread: reply = parent comment nostr event
        if (replyToId) {
          const parentComment = await db.select({ nostrEventId: comments.nostrEventId })
            .from(comments).where(eq(comments.id, replyToId)).limit(1)
          if (parentComment.length > 0 && parentComment[0].nostrEventId) {
            tags.push(['e', parentComment[0].nostrEventId, '', 'reply'])
          }
        }

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags,
        })

        await db.update(comments).set({ nostrEventId: event.id }).where(eq(comments.id, commentId))
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish comment:', e)
      }
    })())
  }

  return c.json({
    id: commentId,
    url: `${baseUrl}/topic/${topicId}#comment-${commentId}`,
  }, 201)
})

// ─── Timeline: 个人动态 ───

// POST /api/posts — 发布个人动态
api.post('/posts', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const body = await c.req.json().catch(() => ({})) as { content?: string }
  const content = body.content?.trim()

  if (!content || content.length < 1 || content.length > 5000) {
    return c.json({ error: 'content is required (1-5000 chars)' }, 400)
  }

  const topicId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(topics).values({
    id: topicId,
    groupId: null,
    userId: user.id,
    title: '',
    content: htmlContent,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // AP: deliver to followers
  c.executionCtx.waitUntil(
    deliverTopicToFollowers(db, baseUrl, user.id, topicId, '', htmlContent)
  )

  // Nostr: broadcast Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = stripHtml(htmlContent).trim()
        const noteContent = textContent
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags: [
            ['client', c.env.APP_NAME || 'NeoGroup'],
          ],
        })
        await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish personal post:', e)
      }
    })())
  }

  return c.json({
    id: topicId,
    url: `${baseUrl}/topic/${topicId}`,
  }, 201)
})

// POST /api/topics/:id/like — 点赞话题
api.post('/topics/:id/like', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const existing = await db.select({ id: topicLikes.id })
    .from(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    .limit(1)

  if (existing.length > 0) {
    // Unlike
    await db.delete(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    return c.json({ liked: false })
  }

  await db.insert(topicLikes).values({
    id: generateId(),
    topicId,
    userId: user.id,
    createdAt: new Date(),
  })

  // Notification
  const topicData = await db.select({ userId: topics.userId }).from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicData.length > 0) {
    await createNotification(db, {
      userId: topicData[0].userId,
      actorId: user.id,
      type: 'topic_like',
      topicId,
    })
  }

  return c.json({ liked: true })
})

// DELETE /api/topics/:id/like — 取消点赞
api.delete('/topics/:id/like', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  await db.delete(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))

  return c.json({ liked: false })
})

// DELETE /api/topics/:id — 删除话题
api.delete('/topics/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  if (topicResult[0].userId !== user.id) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // AP Delete: send Delete activity to all followers
  c.executionCtx.waitUntil((async () => {
    try {
      const apUsername = await getApUsername(db, user.id)
      if (!apUsername) return

      const { privateKeyPem } = await ensureKeyPair(db, user.id)
      const actorUrl = `${baseUrl}/ap/users/${apUsername}`
      const noteId = `${baseUrl}/ap/notes/${topicId}`

      const followers = await db.select().from(apFollowers).where(eq(apFollowers.userId, user.id))
      if (followers.length === 0) return

      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${noteId}/delete`,
        type: 'Delete',
        actor: actorUrl,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actorUrl}/followers`],
        object: noteId,
      }

      const inboxes = new Set<string>()
      for (const f of followers) {
        const inbox = f.sharedInboxUrl || f.inboxUrl
        if (inbox) inboxes.add(inbox)
      }

      for (const inbox of inboxes) {
        try {
          await signAndDeliver(actorUrl, privateKeyPem, inbox, activity)
        } catch (e) {
          console.error(`AP topic delete deliver to ${inbox} failed:`, e)
        }
      }
    } catch (e) {
      console.error('[AP] Failed to deliver topic Delete:', e)
    }
  })())

  // Nostr Kind 5: deletion event
  if (topicResult[0].nostrEventId && user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', topicResult[0].nostrEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to send Kind 5 deletion:', e)
      }
    })())
  }

  // 级联删除
  const topicComments = await db.select({ id: comments.id }).from(comments).where(eq(comments.topicId, topicId))
  for (const comment of topicComments) {
    await db.delete(commentLikes).where(eq(commentLikes.commentId, comment.id))
    await db.delete(commentReposts).where(eq(commentReposts.commentId, comment.id))
  }
  await db.delete(comments).where(eq(comments.topicId, topicId))
  await db.delete(topicLikes).where(eq(topicLikes.topicId, topicId))
  await db.delete(topicReposts).where(eq(topicReposts.topicId, topicId))
  await db.delete(topics).where(eq(topics.id, topicId))

  return c.json({ success: true })
})

// ─── Nostr Follow ───

// POST /api/nostr/follow
api.post('/nostr/follow', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const { pubkeyToNpub, npubToPubkey } = await import('../services/nostr')
  const { getOrCreateNostrUser } = await import('../services/nostr-community')

  const body = await c.req.json().catch(() => ({})) as { pubkey?: string }
  const target = body.pubkey?.trim()
  if (!target) return c.json({ error: 'pubkey is required' }, 400)

  let pubkey: string | null = null
  let npub: string | null = null

  if (target.startsWith('npub1')) {
    pubkey = npubToPubkey(target)
    npub = target
  } else if (/^[0-9a-f]{64}$/i.test(target)) {
    pubkey = target.toLowerCase()
    npub = pubkeyToNpub(pubkey)
  }

  if (!pubkey) return c.json({ error: 'Invalid pubkey or npub' }, 400)

  const existing = await db.select({ id: nostrFollows.id })
    .from(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))
    .limit(1)

  if (existing.length > 0) return c.json({ ok: true, already_following: true })

  await db.insert(nostrFollows).values({
    id: generateId(),
    userId: user.id,
    targetPubkey: pubkey,
    targetNpub: npub,
    createdAt: new Date(),
  })

  // Create shadow user + user_follow
  try {
    const shadowUser = await getOrCreateNostrUser(db, pubkey)
    const existingFollow = await db.select({ id: userFollows.id })
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
  } catch (e) {
    console.error('[API] Failed to create shadow user for Nostr follow:', e)
  }

  return c.json({ ok: true })
})

// DELETE /api/nostr/follow/:pubkey
api.delete('/nostr/follow/:pubkey', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const pubkey = c.req.param('pubkey')

  await db.delete(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))

  return c.json({ ok: true })
})

// GET /api/nostr/following
api.get('/nostr/following', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const list = await db.select({
    id: nostrFollows.id,
    target_pubkey: nostrFollows.targetPubkey,
    target_npub: nostrFollows.targetNpub,
    target_display_name: nostrFollows.targetDisplayName,
    created_at: nostrFollows.createdAt,
  })
    .from(nostrFollows)
    .where(eq(nostrFollows.userId, user.id))
    .orderBy(desc(nostrFollows.createdAt))

  return c.json({ following: list })
})

export default api
