import { createMiddleware } from 'hono/factory'
import { eq, and, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, notifications } from '../db/schema'
import { getSession, getSessionIdFromCookie } from '../services/session'
import { hashApiKey } from '../lib/utils'

// 加载用户信息（不强制登录）
export const loadUser = createMiddleware<AppContext>(async (c, next) => {
  const db = c.get('db')

  // 1. 先检查 Bearer token
  const authHeader = c.req.header('Authorization') || ''
  if (authHeader.startsWith('Bearer neogrp_')) {
    const keyHash = await hashApiKey(authHeader.slice(7).trim())
    const provider = await db.query.authProviders.findFirst({
      where: and(eq(authProviders.providerType, 'apikey'), eq(authProviders.accessToken, keyHash))
    })
    if (provider) {
      const user = await db.query.users.findFirst({ where: eq(users.id, provider.userId) })
      if (user) {
        c.set('user', user)
        c.set('sessionId', null)
        c.set('unreadNotificationCount', 0)
        await next()
        return
      }
    }
    // API 路由下，token 无效直接 401
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }

  // 2. 原有 cookie session 逻辑
  const cookie = c.req.header('Cookie') ?? null
  const sessionId = getSessionIdFromCookie(cookie)

  if (sessionId) {
    const session = await getSession(c.env.KV, sessionId)
    if (session) {
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

// API 认证（JSON 401）
export const requireApiAuth = createMiddleware<AppContext>(async (c, next) => {
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})
