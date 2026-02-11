import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { desc, eq } from 'drizzle-orm'
import { createDb } from './db'
import { groups as groupsTable, topics as topicsTable } from './db/schema'
import { loadUser } from './middleware/auth'
import authRoutes from './routes/auth'
import homeRoutes from './routes/home'
import topicRoutes from './routes/topic'
import groupRoutes from './routes/group'
import userRoutes from './routes/user'
import notificationRoutes from './routes/notification'
import activitypubRoutes from './routes/activitypub'
import apiRoutes from './routes/api'
import timelineRoutes from './routes/timeline'
import type { AppContext, Bindings } from './types'
// import { pollMentions } from './services/mastodon-bot' // Legacy bot polling disabled

// @ts-ignore - Workers Sites manifest
import manifest from '__STATIC_CONTENT_MANIFEST'

const app = new Hono<AppContext>()

// 静态文件
app.use('/static/*', serveStatic({ root: './', manifest }))

// robots.txt
app.get('/robots.txt', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  return c.text(`User-agent: *
Allow: /
Disallow: /auth/
Disallow: /api/

Sitemap: ${baseUrl}/sitemap.xml
`)
})

// sitemap.xml
app.get('/sitemap.xml', async (c) => {
  const db = createDb(c.env.DB)
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const allGroups = await db.select({ id: groupsTable.id, updatedAt: groupsTable.updatedAt }).from(groupsTable)
  const recentTopics = await db
    .select({ id: topicsTable.id, updatedAt: topicsTable.updatedAt })
    .from(topicsTable)
    .orderBy(desc(topicsTable.updatedAt))
    .limit(500)

  const urls = [
    `<url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...allGroups.map(g =>
      `<url><loc>${baseUrl}/group/${g.id}</loc><lastmod>${g.updatedAt.toISOString().split('T')[0]}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`
    ),
    ...recentTopics.map(t =>
      `<url><loc>${baseUrl}/topic/${t.id}</loc><lastmod>${t.updatedAt.toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`
    ),
  ]

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`

  return c.body(xml, 200, { 'Content-Type': 'application/xml' })
})

// R2 文件访问（支持图片裁剪）
app.get('/r2/*', async (c) => {
  const r2 = c.env.R2
  if (!r2) {
    return c.notFound()
  }

  // 防外链：有 Referer 时必须来自本站
  const referer = c.req.header('referer')
  if (referer) {
    const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
    const allowedHost = new URL(baseUrl).host
    try {
      const refererHost = new URL(referer).host
      if (refererHost !== allowedHost && refererHost !== 'www.' + allowedHost) {
        return c.body(null, 403)
      }
    } catch {
      return c.body(null, 403)
    }
  }

  const key = c.req.path.replace('/r2/', '')

  // 获取裁剪参数
  const width = c.req.query('w')
  const height = c.req.query('h')

  // 获取 fit 模式参数
  const fit = c.req.query('fit')

  // 如果有裁剪参数，使用 Cloudflare Image Resizing
  if (width || height) {
    const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
    const originalUrl = `${baseUrl}/r2/${key}`

    const options: RequestInitCfPropertiesImage = {
      // cover: 头像裁剪（固定宽高）; scale-down: 内容图片（等比缩放，只缩不放大）
      fit: (fit as any) || (width && height ? 'cover' : 'scale-down'),
      gravity: 'auto',
    }
    if (width) options.width = parseInt(width)
    if (height) options.height = parseInt(height)

    try {
      const response = await fetch(originalUrl, {
        cf: { image: options }
      })

      if (response.ok) {
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'public, max-age=31536000')
        return new Response(response.body, { headers })
      }
    } catch (e) {
      // 如果裁剪失败，继续返回原图
      console.error('Image resize failed:', e)
    }
  }

  // 返回原图
  const object = await r2.get(key)

  if (!object) {
    return c.notFound()
  }

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'public, max-age=31536000')

  return new Response(object.body, { headers })
})

// 数据库中间件
app.use('*', async (c, next) => {
  const db = createDb(c.env.DB)
  c.set('db', db)
  c.set('user', null)
  c.set('sessionId', null)
  await next()
})

// 加载用户
app.use('*', loadUser)

// 图片上传 API（需要登录）
app.post('/api/upload', async (c) => {
  const user = c.get('user')
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const r2 = c.env.R2
  if (!r2) {
    return c.json({ error: 'Storage not configured' }, 500)
  }

  try {
    const formData = await c.req.formData()
    const file = formData.get('image') as File
    if (!file) {
      return c.json({ error: 'No image provided' }, 400)
    }

    const buffer = await file.arrayBuffer()
    const ext = getExtFromFile(file.name, file.type)
    const contentType = getContentType(ext)
    const id = Math.random().toString(36).substring(2, 14)
    const key = `images/${id}.${ext}`

    await r2.put(key, buffer, {
      httpMetadata: { contentType },
    })

    const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
    return c.json({ url: `${baseUrl}/r2/${key}` })
  } catch (error) {
    console.error('Upload error:', error)
    return c.json({ error: 'Upload failed' }, 500)
  }
})

// NeoDB 元数据代理 API
app.get('/api/neodb', async (c) => {
  const url = c.req.query('url')
  if (!url) {
    return c.json({ error: 'Missing url' }, 400)
  }

  const match = url.match(/neodb\.social\/(movie|book|tv|music|game|podcast|album)((?:\/[a-zA-Z]+)*)\/([a-zA-Z0-9_-]+)/)
  if (!match) {
    return c.json({ error: 'Invalid NeoDB URL' }, 400)
  }

  const [, urlCategory, subPath, id] = match
  // URL 路径到 API 端点的映射（音乐页面路径是 /music/ 但 API 是 /api/album/）
  const apiCategoryMap: Record<string, string> = { music: 'album' }
  const apiCategory = apiCategoryMap[urlCategory] || urlCategory
  const apiPath = `${apiCategory}${subPath}/${id}`
  const cacheKey = `neodb:${apiPath}`

  // Check KV cache
  const kv = c.env.KV
  if (kv) {
    const cached = await kv.get(cacheKey)
    if (cached) {
      return c.json(JSON.parse(cached))
    }
  }

  try {
    const response = await fetch(`https://neodb.social/api/${apiPath}`)
    if (!response.ok) {
      return c.json({ error: 'NeoDB API error' }, 502)
    }

    const data = await response.json() as Record<string, any>
    const result = {
      title: data.display_title || data.title,
      origTitle: data.orig_title,
      coverUrl: data.cover_image_url,
      rating: data.rating,
      ratingCount: data.rating_count,
      year: data.year,
      genre: data.genre,
      brief: data.brief,
      url: url.trim(),
      category: data.category,
    }

    // Cache in KV for 24h
    if (kv) {
      await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 })
    }

    return c.json(result)
  } catch (error) {
    console.error('NeoDB fetch error:', error)
    return c.json({ error: 'Failed to fetch' }, 502)
  }
})

// Mastodon toot 预览 API
app.get('/api/toot-preview', async (c) => {
  const url = c.req.query('url')
  if (!url) {
    return c.json({ error: 'Missing url' }, 400)
  }

  // 支持的 Mastodon URL 格式:
  // https://mastodon.social/@username/123456789
  // https://instance.tld/@username/status_id
  // https://instance.tld/users/username/statuses/status_id
  const match1 = url.match(/^https?:\/\/([^\/]+)\/@([^\/]+)\/(\d+)\/?$/)
  const match2 = url.match(/^https?:\/\/([^\/]+)\/users\/([^\/]+)\/statuses\/(\d+)\/?$/)
  const match = match1 || match2

  if (!match) {
    return c.json({ error: 'Invalid Mastodon URL' }, 400)
  }

  const [, domain, username, statusId] = match
  const cacheKey = `toot:${domain}:${statusId}`

  // Check KV cache
  const kv = c.env.KV
  if (kv) {
    const cached = await kv.get(cacheKey)
    if (cached) {
      return c.json(JSON.parse(cached))
    }
  }

  try {
    // 使用 ActivityPub 获取 toot 数据
    const appName = c.env.APP_NAME || 'NeoGroup'
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        'User-Agent': `${appName}/1.0`,
      },
    })

    if (!response.ok) {
      return c.json({ error: 'Failed to fetch toot' }, 502)
    }

    const data = await response.json() as Record<string, any>

    // 解析 ActivityPub Note 对象
    const attributedTo = data.attributedTo
    let authorName = username
    let authorHandle = `@${username}@${domain}`
    let authorAvatar: string | null = null
    let authorUrl: string | null = null

    // 尝试获取作者信息
    if (typeof attributedTo === 'string') {
      try {
        const actorRes = await fetch(attributedTo, {
          headers: {
            'Accept': 'application/activity+json',
            'User-Agent': `${appName}/1.0`,
          },
        })
        if (actorRes.ok) {
          const actor = await actorRes.json() as Record<string, any>
          authorName = actor.name || actor.preferredUsername || username
          authorHandle = `@${actor.preferredUsername || username}@${domain}`
          authorAvatar = actor.icon?.url || null
          authorUrl = actor.url || attributedTo
        }
      } catch (e) {
        // 忽略作者获取失败
      }
    }

    // 提取内容（去除 HTML 标签的摘要）
    const content = data.content || ''
    const contentText = content.replace(/<[^>]*>/g, '').slice(0, 300)

    // 提取附件（图片）
    const attachments = (data.attachment || [])
      .filter((a: any) => a.mediaType?.startsWith('image/'))
      .slice(0, 4)
      .map((a: any) => ({
        url: a.url,
        type: a.mediaType,
        description: a.name || '',
      }))

    const result = {
      id: statusId,
      url: data.url || url,
      content: contentText,
      contentHtml: content,
      authorName,
      authorHandle,
      authorAvatar,
      authorUrl,
      attachments,
      published: data.published,
      domain,
    }

    // Cache in KV for 1 hour (toots can be edited/deleted)
    if (kv) {
      await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 })
    }

    return c.json(result)
  } catch (error) {
    console.error('Toot fetch error:', error)
    return c.json({ error: 'Failed to fetch toot' }, 502)
  }
})

// 路由
app.route('/api', apiRoutes)
app.route('/', activitypubRoutes)
app.route('/auth', authRoutes)
app.route('/timeline', timelineRoutes)
app.route('/topic', topicRoutes)
app.route('/group', groupRoutes)
app.route('/user', userRoutes)
app.route('/notifications', notificationRoutes)
app.route('/', homeRoutes)

// 管理端点：为所有无 Nostr 密钥的用户批量生成密钥并开启同步
// 支持两种认证：session 登录站长 或 Bearer NOSTR_MASTER_KEY
app.post('/admin/nostr-enable-all', async (c) => {
  const db = c.get('db')
  if (!c.env.NOSTR_MASTER_KEY) return c.json({ error: 'NOSTR_MASTER_KEY not configured' }, 400)

  // 认证：Bearer token = NOSTR_MASTER_KEY，或站长 session
  const authHeader = c.req.header('Authorization') || ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (bearerToken) {
    if (bearerToken !== c.env.NOSTR_MASTER_KEY) return c.json({ error: 'Invalid token' }, 403)
  } else {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const firstUser = await db.query.users.findFirst({ orderBy: (u, { asc }) => [asc(u.createdAt)] })
    if (!firstUser || firstUser.id !== user.id) return c.json({ error: 'Forbidden' }, 403)
  }

  const { generateNostrKeypair, buildSignedEvent } = await import('./services/nostr')
  const { users: usersTable, topics: topicsTable, groups: groupsTable } = await import('./db/schema')
  const { isNull } = await import('drizzle-orm')
  const { stripHtml } = await import('./lib/utils')

  const usersWithoutNostr = await db.select({ id: usersTable.id, username: usersTable.username, displayName: usersTable.displayName, bio: usersTable.bio, avatarUrl: usersTable.avatarUrl, lightningAddress: usersTable.lightningAddress })
    .from(usersTable).where(isNull(usersTable.nostrPubkey))

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const host = new URL(baseUrl).host
  let count = 0

  // 预加载 NIP-72 小组
  const nostrGroups = await db.select({ id: groupsTable.id, nostrSyncEnabled: groupsTable.nostrSyncEnabled, nostrPubkey: groupsTable.nostrPubkey, actorName: groupsTable.actorName })
    .from(groupsTable).where(eq(groupsTable.nostrSyncEnabled, 1))
  const groupMap = new Map(nostrGroups.map(g => [g.id, g]))
  const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''

  for (const u of usersWithoutNostr) {
    try {
      const { pubkey, privEncrypted, iv } = await generateNostrKeypair(c.env.NOSTR_MASTER_KEY)
      await db.update(usersTable).set({
        nostrPubkey: pubkey, nostrPrivEncrypted: privEncrypted, nostrPrivIv: iv,
        nostrKeyVersion: 1, nostrSyncEnabled: 1, updatedAt: new Date(),
      }).where(eq(usersTable.id, u.id))

      if (c.env.NOSTR_QUEUE) {
        // Kind 0 metadata
        const metaEvent = await buildSignedEvent({
          privEncrypted, iv, masterKey: c.env.NOSTR_MASTER_KEY,
          kind: 0, content: JSON.stringify({
            name: u.displayName || u.username, about: u.bio ? u.bio.replace(/<[^>]*>/g, '') : '',
            picture: u.avatarUrl || '', nip05: `${u.username}@${host}`,
            ...(u.lightningAddress ? { lud16: `${u.username}@${host}` } : {}),
            ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
          }), tags: [],
        })
        await c.env.NOSTR_QUEUE.send({ events: [metaEvent] })

        // 回填帖子
        const userTopics = await db.select({ id: topicsTable.id, title: topicsTable.title, content: topicsTable.content, groupId: topicsTable.groupId, createdAt: topicsTable.createdAt, nostrEventId: topicsTable.nostrEventId })
          .from(topicsTable).where(eq(topicsTable.userId, u.id)).orderBy(topicsTable.createdAt)

        const BATCH_SIZE = 10
        for (let i = 0; i < userTopics.length; i += BATCH_SIZE) {
          const batch = userTopics.slice(i, i + BATCH_SIZE)
          const events = []
          for (const t of batch) {
            if (t.nostrEventId) continue
            const textContent = t.content ? stripHtml(t.content).trim() : ''
            const noteContent = textContent
              ? `${t.title}\n\n${textContent}\n\n🔗 ${baseUrl}/topic/${t.id}`
              : `${t.title}\n\n🔗 ${baseUrl}/topic/${t.id}`
            const nostrTags: string[][] = [['r', `${baseUrl}/topic/${t.id}`], ['client', c.env.APP_NAME || 'NeoGroup']]
            const g = groupMap.get(t.groupId)
            if (g && g.nostrPubkey && g.actorName) {
              nostrTags.push(['a', `34550:${g.nostrPubkey}:${g.actorName}`, relayUrl])
            }
            const event = await buildSignedEvent({ privEncrypted, iv, masterKey: c.env.NOSTR_MASTER_KEY!, kind: 1, content: noteContent, tags: nostrTags, createdAt: Math.floor(t.createdAt.getTime() / 1000) })
            await db.update(topicsTable).set({ nostrEventId: event.id }).where(eq(topicsTable.id, t.id))
            events.push(event)
          }
          if (events.length > 0) await c.env.NOSTR_QUEUE.send({ events })
        }
      }
      count++
      console.log(`[Nostr] Batch-enabled user ${u.username} (${count}/${usersWithoutNostr.length})`)
    } catch (e) {
      console.error(`[Nostr] Failed to enable user ${u.username}:`, e)
    }
  }

  return c.json({ ok: true, enabled: count, total: usersWithoutNostr.length })
})

export default {
  fetch: app.fetch,
  // Cron: NIP-72 community poll + Nostr follow sync
  scheduled: async (_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) => {
    const { createDb } = await import('./db')
    const db = createDb(env.DB)

    // NIP-72: poll Nostr relays for community posts
    try {
      const { pollCommunityPosts } = await import('./services/nostr-community')
      await pollCommunityPosts(env, db)
    } catch (e) {
      console.error('[Cron] NIP-72 poll failed:', e)
    }

    // Poll followed Nostr users
    try {
      const { pollFollowedUsers } = await import('./services/nostr-community')
      await pollFollowedUsers(env, db)
    } catch (e) {
      console.error('[Cron] Nostr follow poll failed:', e)
    }

    // Poll followed Nostr communities
    try {
      const { pollFollowedCommunities } = await import('./services/nostr-community')
      await pollFollowedCommunities(env, db)
    } catch (e) {
      console.error('[Cron] Nostr community follow poll failed:', e)
    }

    // Sync Kind 3 contact lists from relay
    try {
      const { syncContactListsFromRelay } = await import('./services/nostr-community')
      await syncContactListsFromRelay(env, db)
    } catch (e) {
      console.error('[Cron] Nostr contact list sync failed:', e)
    }

    // Poll Nostr Kind 7 reactions (likes)
    try {
      const { pollNostrReactions } = await import('./services/nostr-community')
      await pollNostrReactions(env, db)
    } catch (e) {
      console.error('[Cron] Nostr reactions poll failed:', e)
    }

    // Poll Nostr Kind 1 replies (comments)
    try {
      const { pollNostrReplies } = await import('./services/nostr-community')
      await pollNostrReplies(env, db)
    } catch (e) {
      console.error('[Cron] Nostr replies poll failed:', e)
    }

    // Note: Nostr auto-enable for users/groups has completed (all 286 users + 55 groups done).
    // Code removed since it's no longer needed.
  },
  // Nostr Queue consumer: publish signed events directly to relays via WebSocket
  async queue(batch: MessageBatch, env: Bindings) {
    const events: any[] = []
    for (const msg of batch.messages) {
      const payload = msg.body as { events: any[] }
      if (payload?.events) {
        events.push(...payload.events)
      }
    }

    if (events.length === 0) return

    const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
    if (relayUrls.length === 0) {
      console.error('[Nostr] No relays configured (NOSTR_RELAYS)')
      return
    }

    let successCount = 0
    for (const relayUrl of relayUrls) {
      try {
        const ok = await publishToRelay(relayUrl, events)
        console.log(`[Nostr] ${relayUrl}: ${ok}/${events.length} events accepted`)
        if (ok > 0) successCount++
      } catch (e) {
        console.error(`[Nostr] ${relayUrl} failed:`, e)
      }
    }

    if (successCount === 0) {
      throw new Error(`[Nostr] Failed to publish to any relay (${relayUrls.length} tried)`)
    }

    console.log(`[Nostr] Published ${events.length} events to ${successCount}/${relayUrls.length} relays`)
  },
}

function getExtFromFile(filename: string, mimeType: string): string {
  const match = filename.match(/\.(\w+)$/)
  if (match) {
    const ext = match[1].toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return ext === 'jpg' ? 'jpeg' : ext
    }
  }
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }
  return mimeMap[mimeType] || 'png'
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  return types[ext] || 'image/png'
}

// Publish Nostr events to a single relay via WebSocket
async function publishToRelay(relayUrl: string, events: any[]): Promise<number> {
  // Workers use fetch with Upgrade header for outbound WebSocket
  const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://')
  const resp = await fetch(httpUrl, {
    headers: { Upgrade: 'websocket' },
  })

  const ws = (resp as any).webSocket as WebSocket
  if (!ws) {
    throw new Error('WebSocket upgrade failed')
  }
  ws.accept()

  return new Promise<number>((resolve) => {
    let okCount = 0
    const timeout = setTimeout(() => {
      try { ws.close() } catch {}
      resolve(okCount)
    }, 10000)

    ws.addEventListener('message', (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string)
        if (Array.isArray(data) && data[0] === 'OK') {
          okCount++
          if (okCount >= events.length) {
            clearTimeout(timeout)
            try { ws.close() } catch {}
            resolve(okCount)
          }
        }
      } catch {}
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
      resolve(okCount)
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      resolve(okCount)
    })

    // Send all events
    for (const event of events) {
      ws.send(JSON.stringify(['EVENT', event]))
    }
  })
}
