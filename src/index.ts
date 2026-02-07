import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { desc } from 'drizzle-orm'
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
import type { AppContext, Bindings } from './types'
import { pollMentions } from './services/mastodon-bot'

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

// 路由
app.route('/', activitypubRoutes)
app.route('/auth', authRoutes)
app.route('/topic', topicRoutes)
app.route('/group', groupRoutes)
app.route('/user', userRoutes)
app.route('/notifications', notificationRoutes)
app.route('/', homeRoutes)

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    const db = createDb(env.DB)
    ctx.waitUntil(pollMentions(env, db))
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
