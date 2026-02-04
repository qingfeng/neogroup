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

// R2 文件访问
app.get('/r2/*', async (c) => {
  const r2 = c.env.R2
  if (!r2) {
    return c.notFound()
  }

  const key = c.req.path.replace('/r2/', '')
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

// 路由
app.route('/auth', authRoutes)
app.route('/topic', topicRoutes)
app.route('/group', groupRoutes)
app.route('/user', userRoutes)
app.route('/', homeRoutes)

export default app
