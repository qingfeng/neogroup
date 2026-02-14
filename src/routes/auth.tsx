import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, mastodonApps } from '../db/schema'
import { generateId, now, uploadAvatarToR2, mastodonUsername, ensureUniqueUsername, stripHtml, isNostrEnabled } from '../lib/utils'
import { generateNostrKeypair, buildSignedEvent, verifyEvent, nsecToPrivkey, pubkeyToNpub, encryptPrivkey } from '../services/nostr'
import { fetchEventsFromRelay } from '../services/nostr-community'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { topics } from '../db/schema'
import type { Database } from '../db'
import { Layout } from '../components/Layout'
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

  const loginCss = `
    .login-container { max-width: 420px; margin: 30px auto; padding: 0 20px; }
    .login-container h1 { text-align: center; margin-bottom: 24px; font-size: 20px; }
    .login-panel { border: 2px solid #e0e0d8; border-radius: 6px; padding: 24px; background: #fff; }
    .login-panel input[type="text"] { width: 100%; padding: 10px; margin: 8px 0; box-sizing: border-box; border: 1px solid #c7deb8; border-radius: 3px; font-size: 13px; }
    .login-panel .btn-login { width: 100%; padding: 10px; font-size: 13px; margin-top: 8px; }
    .login-panel label { font-size: 13px; color: #555; }
  `

  return c.html(
    <Layout user={null} title="登录" siteName={appName}>
      <style dangerouslySetInnerHTML={{ __html: loginCss }} />
      <div class="login-container">
        <h1>登录 {appName}</h1>
        <div class="login-panel">
          <form action="/auth/connect" method="get">
            <label>输入你的 Mastodon 实例域名：</label>
            <input type="text" name="domain" placeholder="mastodon.social" required />
            <button type="submit" class="btn btn-primary btn-login">使用 Mastodon 登录</button>
          </form>
        </div>
      </div>
    </Layout>
  )
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

    // 创建 session
    const sessionId = await createSession(c.env.KV, userId)
    c.header('Set-Cookie', createSessionCookie(sessionId))

    return c.redirect('/')
  } catch (error) {
    console.error('Callback error:', error)
    return c.html(`<p>登录失败: ${error}</p><a href="/auth/login">重试</a>`)
  }
})

// --- Nostr 登录辅助函数 ---

async function findOrCreateNostrUser(
  db: Database,
  pubkey: string,
  env: { NOSTR_MASTER_KEY?: string },
): Promise<{ userId: string; isNew: boolean }> {
  // 1. 查 auth_provider: provider_type='nostr' + provider_id=pubkey
  const existingAuth = await db
    .select({ userId: authProviders.userId })
    .from(authProviders)
    .where(and(
      eq(authProviders.providerType, 'nostr'),
      eq(authProviders.providerId, pubkey),
    ))
    .limit(1)

  if (existingAuth.length > 0) {
    return { userId: existingAuth[0].userId, isNew: false }
  }

  // 2. 查 users.nostr_pubkey=pubkey（Mastodon 用户已开启 Nostr 同步）
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.nostrPubkey, pubkey))
    .limit(1)

  if (existingUser.length > 0) {
    const userId = existingUser[0].id
    // 补建 auth_provider
    await db.insert(authProviders).values({
      id: generateId(),
      userId,
      providerType: 'nostr',
      providerId: pubkey,
      metadata: JSON.stringify({ npub: pubkeyToNpub(pubkey) }),
      createdAt: now(),
    })
    return { userId, isNew: false }
  }

  // 3. 创建新用户
  const npub = pubkeyToNpub(pubkey)
  const baseUsername = npub.slice(0, 16)
  const username = await ensureUniqueUsername(db, baseUsername)
  const displayName = npub.slice(0, 12) + '...'
  const userId = generateId()

  await db.insert(users).values({
    id: userId,
    username,
    displayName,
    nostrPubkey: pubkey,
    nostrSyncEnabled: 0,
    createdAt: now(),
    updatedAt: now(),
  })

  await db.insert(authProviders).values({
    id: generateId(),
    userId,
    providerType: 'nostr',
    providerId: pubkey,
    metadata: JSON.stringify({ npub }),
    createdAt: now(),
  })

  console.log(`[Nostr Auth] Created user ${username} for pubkey ${pubkey.slice(0, 8)}...`)
  return { userId, isNew: true }
}

// --- Nostr 登录端点 ---

// 生成 challenge
auth.post('/nostr/challenge', async (c) => {
  if (!isNostrEnabled(c.env)) return c.notFound()
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const challenge = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')

  await c.env.KV.put(`nostr_challenge:${challenge}`, '1', { expirationTtl: 300 })

  return c.json({ challenge })
})

// NIP-07 验证签名事件
auth.post('/nostr/verify', async (c) => {
  if (!isNostrEnabled(c.env)) return c.notFound()
  try {
    const body = await c.req.json()
    const event = body.event

    if (!event || !event.id || !event.pubkey || !event.sig || !event.tags) {
      return c.json({ error: '无效的事件格式' }, 400)
    }

    // 验证 Kind 22242
    if (event.kind !== 22242) {
      return c.json({ error: '无效的事件类型' }, 400)
    }

    // 验证签名
    if (!verifyEvent(event)) {
      return c.json({ error: '签名验证失败' }, 400)
    }

    // 验证 created_at 在 5 分钟内
    const nowTs = Math.floor(Date.now() / 1000)
    if (Math.abs(nowTs - event.created_at) > 300) {
      return c.json({ error: '事件已过期' }, 400)
    }

    // 提取并验证 challenge
    const challengeTag = event.tags.find((t: string[]) => t[0] === 'challenge')
    if (!challengeTag || !challengeTag[1]) {
      return c.json({ error: '缺少 challenge' }, 400)
    }

    const challengeKey = `nostr_challenge:${challengeTag[1]}`
    const stored = await c.env.KV.get(challengeKey)
    if (!stored) {
      return c.json({ error: 'challenge 无效或已过期' }, 400)
    }
    await c.env.KV.delete(challengeKey)

    // 查找或创建用户
    const db = c.get('db')
    const { userId } = await findOrCreateNostrUser(db, event.pubkey, c.env)

    // 创建 session
    const sessionId = await createSession(c.env.KV, userId)
    c.header('Set-Cookie', createSessionCookie(sessionId))

    return c.json({ ok: true, redirect: '/' })
  } catch (error) {
    console.error('[Nostr Auth] verify error:', error)
    return c.json({ error: '登录失败' }, 500)
  }
})

// nsec 私钥登录
auth.post('/nostr/nsec', async (c) => {
  if (!isNostrEnabled(c.env)) return c.notFound()
  try {
    let nsec: string

    const contentType = c.req.header('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = await c.req.json()
      nsec = body.nsec
    } else {
      const form = await c.req.parseBody()
      nsec = form.nsec as string
    }

    if (!nsec || typeof nsec !== 'string') {
      return c.html(`<p>请输入 nsec 私钥</p><a href="/auth/login?tab=nostr">重试</a>`)
    }

    nsec = nsec.trim()

    // 解码 nsec → privkey hex
    const privkeyHex = nsecToPrivkey(nsec)
    if (!privkeyHex) {
      return c.html(`<p>无效的 nsec 格式</p><a href="/auth/login?tab=nostr">重试</a>`)
    }

    // 推导 pubkey
    const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privkeyHex)))

    // 查找或创建用户
    const db = c.get('db')
    const { userId } = await findOrCreateNostrUser(db, pubkey, c.env)

    // 加密存储 nsec 私钥，开启 Nostr 同步
    if (c.env.NOSTR_MASTER_KEY) {
      const userRow = await db.query.users.findFirst({
        where: eq(users.id, userId),
      })

      if (userRow) {
        const needsKeyUpdate = !userRow.nostrPrivEncrypted || userRow.nostrPubkey !== pubkey

        if (needsKeyUpdate) {
          const { encrypted, iv } = await encryptPrivkey(privkeyHex, c.env.NOSTR_MASTER_KEY)
          await db.update(users).set({
            nostrPubkey: pubkey,
            nostrPrivEncrypted: encrypted,
            nostrPrivIv: iv,
            nostrKeyVersion: 1,
            nostrSyncEnabled: 1,
            updatedAt: now(),
          }).where(eq(users.id, userId))

          // 从 relay 拉取用户现有 Kind 0 metadata
          let relayMeta: { name?: string; display_name?: string; picture?: string; about?: string; nip05?: string; lud16?: string } = {}
          try {
            const relayUrls = (c.env.NOSTR_RELAYS || '').split(',').map((s: string) => s.trim()).filter(Boolean)
            for (const relayUrl of relayUrls) {
              const { events } = await fetchEventsFromRelay(relayUrl, {
                kinds: [0],
                authors: [pubkey],
                limit: 1,
              })
              if (events.length > 0) {
                const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
                relayMeta = JSON.parse(latest.content)
                break
              }
            }
          } catch (e) {
            console.error('[Nostr Auth] Failed to fetch Kind 0 from relay:', e)
          }

          // 用 relay 元数据填充站内空白字段
          const profileUpdate: Record<string, unknown> = { updatedAt: now() }
          const relayDisplayName = relayMeta.display_name || relayMeta.name
          if (!userRow.displayName && relayDisplayName) profileUpdate.displayName = relayDisplayName
          if (!userRow.avatarUrl && relayMeta.picture) profileUpdate.avatarUrl = relayMeta.picture
          if (!userRow.bio && relayMeta.about) {
            profileUpdate.bio = `<p>${relayMeta.about.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
          }
          if (Object.keys(profileUpdate).length > 1) {
            await db.update(users).set(profileUpdate).where(eq(users.id, userId))
          }

          // 广播 Kind 0 metadata（保留原有 nip05）
          if (c.env.NOSTR_QUEUE) {
            const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
            const host = new URL(baseUrl).host
            const effectiveDisplayName = (profileUpdate.displayName as string) || userRow.displayName || userRow.username
            const effectiveBio = userRow.bio || (profileUpdate.bio as string) || ''
            const effectiveAvatar = (profileUpdate.avatarUrl as string) || userRow.avatarUrl || ''
            const metadataEvent = await buildSignedEvent({
              privEncrypted: encrypted, iv,
              masterKey: c.env.NOSTR_MASTER_KEY,
              kind: 0,
              content: JSON.stringify({
                name: effectiveDisplayName,
                about: effectiveBio.replace(/<[^>]*>/g, ''),
                picture: effectiveAvatar,
                nip05: relayMeta.nip05 || `${userRow.username}@${host}`,
                lud16: `${userRow.username}@${host}`,
                ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
              }),
              tags: [],
            })
            await c.env.NOSTR_QUEUE.send({ events: [metadataEvent] })
          }

          console.log(`[Nostr Auth] Stored nsec key for user ${userId}`)
        } else if (!userRow.nostrSyncEnabled) {
          // 有密钥但同步未开启，开启同步
          await db.update(users).set({
            nostrSyncEnabled: 1,
            updatedAt: now(),
          }).where(eq(users.id, userId))
        }
      }
    }

    // 创建 session
    const sessionId = await createSession(c.env.KV, userId)
    c.header('Set-Cookie', createSessionCookie(sessionId))

    return c.redirect('/')
  } catch (error) {
    console.error('[Nostr Auth] nsec error:', error)
    return c.html(`<p>登录失败: ${error}</p><a href="/auth/login?tab=nostr">重试</a>`)
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
