import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { createDb } from './db'
import { loadUser } from './middleware/auth'
import authRoutes from './routes/auth'
import homeRoutes from './routes/home'
import topicRoutes from './routes/topic'
import groupRoutes from './routes/group'
import userRoutes from './routes/user'
import type { AppContext } from './types'

// @ts-ignore - Workers Sites manifest
import manifest from '__STATIC_CONTENT_MANIFEST'

const app = new Hono<AppContext>()

// 静态文件
app.use('/static/*', serveStatic({ root: './', manifest }))

// R2 文件访问（支持图片裁剪）
app.get('/r2/*', async (c) => {
  const r2 = c.env.R2
  if (!r2) {
    return c.notFound()
  }

  const key = c.req.path.replace('/r2/', '')

  // 获取裁剪参数
  const width = c.req.query('w')
  const height = c.req.query('h')

  // 如果有裁剪参数，使用 Cloudflare Image Resizing
  if (width || height) {
    const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
    const originalUrl = `${baseUrl}/r2/${key}`

    const options: RequestInitCfPropertiesImage = {
      fit: 'cover',
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

// 路由
app.route('/auth', authRoutes)
app.route('/topic', topicRoutes)
app.route('/group', groupRoutes)
app.route('/user', userRoutes)
app.route('/', homeRoutes)

export default app

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
