import { createMiddleware } from 'hono/factory'
import { eq, and, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, notifications } from '../db/schema'
import { getSession, getSessionIdFromCookie } from '../services/session'

// 加载用户信息（不强制登录）
export const loadUser = createMiddleware<AppContext>(async (c, next) => {
  const cookie = c.req.header('Cookie') ?? null
  const sessionId = getSessionIdFromCookie(cookie)

  if (sessionId) {
    const session = await getSession(c.env.KV, sessionId)
    if (session) {
      const db = c.get('db')
      const user = await db.query.users.findFirst({
        where: eq(users.id, session.userId),
      })
      if (user) {
        c.set('user', user)
        c.set('sessionId', sessionId)
        const unread = await db
          .select({ count: sql<number>`count(*)` })
          .from(notifications)
          .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, 0)))
        c.set('unreadNotificationCount', unread[0]?.count || 0)
      }
    }
  }

  await next()
})

// 强制要求登录
export const requireAuth = createMiddleware<AppContext>(async (c, next) => {
  const user = c.get('user')
  if (!user) {
    return c.redirect('/auth/login')
  }
  await next()
})
