import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, mastodonApps } from '../db/schema'
import { generateId, now, uploadAvatarToR2, mastodonUsername, ensureUniqueUsername, stripHtml } from '../lib/utils'
import { generateNostrKeypair, buildSignedEvent } from '../services/nostr'
import { topics } from '../db/schema'
import {
  getOrCreateApp,
  getAuthorizationUrl,
  exchangeCodeForToken,
  verifyCredentials,
} from '../services/mastodon'
import {
  createSession,
  createSessionCookie,
  createLogoutCookie,
  deleteSession,
} from '../services/session'

const auth = new Hono<AppContext>()

// 登录页面
auth.get('/login', (c) => {
  const user = c.get('user')
  if (user) {
    return c.redirect('/')
  }

  const appName = c.env.APP_NAME || 'NeoGroup'

  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>登录 - ${appName}</title>
      <style>
        body { font-family: system-ui; max-width: 400px; margin: 50px auto; padding: 20px; }
        input { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; }
        button { width: 100%; padding: 10px; background: #6364ff; color: white; border: none; cursor: pointer; }
        button:hover { background: #5253e0; }
      </style>
    </head>
    <body>
      <h1>登录 ${appName}</h1>
      <form action="/auth/connect" method="get">
        <label>输入你的 Mastodon 实例域名：</label>
        <input type="text" name="domain" placeholder="mastodon.social" required />
        <button type="submit">使用 Mastodon 登录</button>
      </form>
    </body>
    </html>
  `)
})

// 获取当前请求的 origin
function getOrigin(c: any): string {
  const url = new URL(c.req.url)
  return `${url.protocol}//${url.host}`
}

// 跳转到 Mastodon 授权
auth.get('/connect', async (c) => {
  const domain = c.req.query('domain')?.trim().toLowerCase()
  if (!domain) {
    return c.redirect('/auth/login')
  }

  const db = c.get('db')
  const appUrl = getOrigin(c)
  const appName = c.env.APP_NAME || 'NeoGroup'

  try {
    const { clientId } = await getOrCreateApp(db, domain, appName, appUrl)
    const state = `${domain}:${generateId()}`
    const redirectUri = `${appUrl}/auth/callback`
    const authUrl = getAuthorizationUrl(domain, clientId, redirectUri, state)

    // 存储 state 和 origin 用于验证
    await c.env.KV.put(`oauth_state:${state}`, JSON.stringify({ domain, origin: appUrl }), { expirationTtl: 600 })

    return c.redirect(authUrl)
  } catch (error) {
    console.error('Connect error:', error)
    return c.html(`<p>连接失败: ${error}</p><a href="/auth/login">重试</a>`)
  }
})

// OAuth 回调
auth.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    return c.html(`<p>授权失败: ${error}</p><a href="/auth/login">重试</a>`)
  }

  if (!code || !state) {
    return c.redirect('/auth/login')
  }

  // 验证 state
  const stateData = await c.env.KV.get(`oauth_state:${state}`)
  if (!stateData) {
    return c.html(`<p>授权已过期</p><a href="/auth/login">重试</a>`)
  }
  await c.env.KV.delete(`oauth_state:${state}`)

  // 解析 state 数据 (兼容旧格式)
  let domain: string
  let appUrl: string
  try {
    const parsed = JSON.parse(stateData)
    domain = parsed.domain
    appUrl = parsed.origin
  } catch {
    // 旧格式兼容
    domain = stateData
    appUrl = getOrigin(c)
  }

  const db = c.get('db')
  const appName = c.env.APP_NAME || 'NeoGroup'

  try {
    // 获取应用凭证 (使用组合 key: mastodon域名:我们的域名)
    const ourHost = new URL(appUrl).host
    const lookupDomain = `${domain}:${ourHost}`
    const app = await db.query.mastodonApps.findFirst({
      where: eq(mastodonApps.domain, lookupDomain),
    })
    if (!app) {
      throw new Error('App not found')
    }

    // 换取 token
    const redirectUri = `${appUrl}/auth/callback`
    const token = await exchangeCodeForToken(
      domain,
      app.clientId,
      app.clientSecret,
      code,
      redirectUri
    )

    // 获取用户信息
    const account = await verifyCredentials(domain, token.access_token)
    const providerId = `${account.id}@${domain}`

    // 查找或创建用户
    let authProvider = await db.query.authProviders.findFirst({
      where: and(
        eq(authProviders.providerType, 'mastodon'),
        eq(authProviders.providerId, providerId)
      ),
    })

    let userId: string

    if (authProvider) {
      // 更新 token
      await db.update(authProviders)
        .set({
          accessToken: token.access_token,
          refreshToken: token.refresh_token || null,
          metadata: JSON.stringify(account),
        })
        .where(eq(authProviders.id, authProvider.id))

      userId = authProvider.userId

      // 上传头像到 R2
      const avatarUrl = await uploadAvatarToR2(
        c.env.R2,
        userId,
        account.avatar,
        appUrl,
        appName
      )

      // 更新用户信息
      await db.update(users)
        .set({
          displayName: account.display_name || account.username,
          avatarUrl,
          updatedAt: now(),
        })
        .where(eq(users.id, userId))
    } else {
      const baseUsername = mastodonUsername(account.username, domain)
      const username = await ensureUniqueUsername(db, baseUsername)

      // 检查是否已有同名用户（从 Mastodon 同步创建的）
      const existingByUsername = await db.query.users.findFirst({
        where: eq(users.username, username),
      })

      if (existingByUsername) {
        // 复用已有用户，补充 OAuth 信息
        userId = existingByUsername.id
      } else {
        // 创建新用户
        userId = generateId()

        await db.insert(users).values({
          id: userId,
          username,
          displayName: account.display_name || account.username,
          avatarUrl: account.avatar,
          bio: null,
          createdAt: now(),
          updatedAt: now(),
        })
      }

      // 上传头像到 R2
      const avatarUrl = await uploadAvatarToR2(
        c.env.R2,
        userId,
        account.avatar,
        appUrl,
        appName
      )

      // 更新用户信息（头像、昵称）
      await db.update(users)
        .set({
          displayName: account.display_name || account.username,
          avatarUrl,
          updatedAt: now(),
        })
        .where(eq(users.id, userId))

      await db.insert(authProviders).values({
        id: generateId(),
        userId,
        providerType: 'mastodon',
        providerId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        metadata: JSON.stringify(account),
        createdAt: now(),
      })
    }

    // 自动开启 Nostr：如果用户还没有 Nostr 密钥，则生成并启用
    if (c.env.NOSTR_MASTER_KEY) {
      const userRow = await db.query.users.findFirst({
        where: eq(users.id, userId),
      })
      if (userRow && !userRow.nostrPubkey) {
        try {
          const { pubkey, privEncrypted, iv } = await generateNostrKeypair(c.env.NOSTR_MASTER_KEY)
          const username = userRow.username
          await db.update(users).set({
            nostrPubkey: pubkey,
            nostrPrivEncrypted: privEncrypted,
            nostrPrivIv: iv,
            nostrKeyVersion: 1,
            nostrSyncEnabled: 1,
            updatedAt: now(),
          }).where(eq(users.id, userId))

          // 广播 Kind 0 + 回填历史帖子（后台）
          if (c.env.NOSTR_QUEUE) {
            const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
            const host = new URL(baseUrl).host
            const metadataEvent = await buildSignedEvent({
              privEncrypted, iv,
              masterKey: c.env.NOSTR_MASTER_KEY,
              kind: 0,
              content: JSON.stringify({
                name: userRow.displayName || username,
                about: userRow.bio ? userRow.bio.replace(/<[^>]*>/g, '') : '',
                picture: userRow.avatarUrl || '',
                nip05: `${username}@${host}`,
                ...((userRow as any).lightningAddress ? { lud16: `${username}@${host}` } : {}),
                ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
              }),
              tags: [],
            })
            await c.env.NOSTR_QUEUE.send({ events: [metadataEvent] })

            // 回填历史帖子（后台执行）
            c.executionCtx.waitUntil((async () => {
              try {
                const { groups } = await import('../db/schema')
                const userTopics = await db
                  .select({
                    id: topics.id,
                    title: topics.title,
                    content: topics.content,
                    groupId: topics.groupId,
                    createdAt: topics.createdAt,
                    nostrEventId: topics.nostrEventId,
                  })
                  .from(topics)
                  .where(eq(topics.userId, userId))
                  .orderBy(topics.createdAt)

                // 预加载所有 NIP-72 小组信息
                const nostrGroups = await db.select({
                  id: groups.id,
                  nostrSyncEnabled: groups.nostrSyncEnabled,
                  nostrPubkey: groups.nostrPubkey,
                  actorName: groups.actorName,
                }).from(groups).where(eq(groups.nostrSyncEnabled, 1))
                const groupMap = new Map(nostrGroups.map(g => [g.id, g]))
                const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''

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
                    const nostrTags: string[][] = [
                      ['r', `${baseUrl}/topic/${t.id}`],
                      ['client', c.env.APP_NAME || 'NeoGroup'],
                    ]
                    const g = groupMap.get(t.groupId)
                    if (g && g.nostrPubkey && g.actorName) {
                      nostrTags.push(['a', `34550:${g.nostrPubkey}:${g.actorName}`, relayUrl])
                    }
                    const event = await buildSignedEvent({
                      privEncrypted, iv,
                      masterKey: c.env.NOSTR_MASTER_KEY!,
                      kind: 1, content: noteContent, tags: nostrTags,
                      createdAt: Math.floor(t.createdAt.getTime() / 1000),
                    })
                    await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, t.id))
                    events.push(event)
                  }
                  if (events.length > 0) {
                    await c.env.NOSTR_QUEUE!.send({ events })
                  }
                }
                console.log(`[Nostr] Auto-enabled + backfilled for user ${userId}`)
              } catch (e) {
                console.error('[Nostr] Auto-enable backfill failed:', e)
              }
            })())
          }
          console.log(`[Nostr] Auto-generated keypair for user ${userId}`)
        } catch (e) {
          console.error('[Nostr] Auto-generate keypair failed:', e)
        }
      }
    }

    // 创建 session
    const sessionId = await createSession(c.env.KV, userId)
    c.header('Set-Cookie', createSessionCookie(sessionId))

    return c.redirect('/')
  } catch (error) {
    console.error('Callback error:', error)
    return c.html(`<p>登录失败: ${error}</p><a href="/auth/login">重试</a>`)
  }
})

// 登出
auth.post('/logout', async (c) => {
  const sessionId = c.get('sessionId')
  if (sessionId) {
    await deleteSession(c.env.KV, sessionId)
  }
  c.header('Set-Cookie', createLogoutCookie())
  return c.redirect('/')
})

auth.get('/logout', async (c) => {
  const sessionId = c.get('sessionId')
  if (sessionId) {
    await deleteSession(c.env.KV, sessionId)
  }
  c.header('Set-Cookie', createLogoutCookie())
  return c.redirect('/')
})

export default auth
