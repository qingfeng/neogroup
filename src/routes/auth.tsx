import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, mastodonApps } from '../db/schema'
import { generateId, now, uploadAvatarToR2, mastodonUsername, ensureUniqueUsername, stripHtml } from '../lib/utils'
import { generateNostrKeypair, buildSignedEvent, verifyEvent, nsecToPrivkey, pubkeyToNpub, encryptPrivkey } from '../services/nostr'
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
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const tab = c.req.query('tab') || 'agent'

  const loginCss = `
    .login-container { max-width: 420px; margin: 30px auto; padding: 0 20px; }
    .login-container h1 { text-align: center; margin-bottom: 24px; font-size: 20px; }
    .login-tabs { display: flex; gap: 0; margin-bottom: 0; border-bottom: 2px solid #e0e0d8; }
    .login-tab { flex: 1; padding: 10px 0; text-align: center; cursor: pointer; font-size: 14px; font-weight: 500; color: #666; background: none; border: 2px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; text-decoration: none; display: block; margin-bottom: -2px; }
    .login-tab:hover { color: #333; background: #f0f0ea; text-decoration: none; }
    .login-tab.active { color: #072; border-color: #e0e0d8; border-bottom-color: #f6f6f1; background: #f6f6f1; }
    .login-panel { border: 2px solid #e0e0d8; border-top: none; border-radius: 0 0 6px 6px; padding: 24px; background: #fff; }
    .login-panel input[type="text"] { width: 100%; padding: 10px; margin: 8px 0; box-sizing: border-box; border: 1px solid #c7deb8; border-radius: 3px; font-size: 13px; }
    .login-panel .btn-login { width: 100%; padding: 10px; font-size: 13px; margin-top: 8px; }
    .login-panel label { font-size: 13px; color: #555; }
    .agent-cmd { background: #f0f0ea; border: 1px solid #ddd; border-radius: 4px; padding: 12px 14px; font-family: "SF Mono", Monaco, "Cascadia Code", monospace; font-size: 12.5px; color: #333; word-break: break-all; margin: 12px 0; user-select: all; cursor: pointer; position: relative; }
    .agent-cmd:hover { background: #e8e8e0; }
    .agent-cmd::after { content: "click to copy"; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: #999; font-family: system-ui; }
    .agent-steps { margin: 16px 0 0; padding: 0; list-style: none; }
    .agent-steps li { padding: 4px 0; font-size: 13px; color: #555; }
    .agent-steps li strong { color: #072; }
  `

  const nostrCss = `
    .nostr-section { margin-bottom: 20px; }
    .nostr-section:last-child { margin-bottom: 0; }
    .nostr-divider { display: flex; align-items: center; margin: 20px 0; color: #999; font-size: 12px; }
    .nostr-divider::before, .nostr-divider::after { content: ''; flex: 1; border-top: 1px solid #e0e0d8; }
    .nostr-divider span { padding: 0 12px; }
    .nostr-section h3 { font-size: 14px; margin: 0 0 8px; color: #333; }
    .nostr-section p { font-size: 12px; color: #888; margin: 4px 0 12px; }
    .login-panel input[type="password"] { width: 100%; padding: 10px; margin: 8px 0; box-sizing: border-box; border: 1px solid #c7deb8; border-radius: 3px; font-size: 13px; }
    #nip07-unavailable { display: none; font-size: 12px; color: #c63; margin-top: 8px; }
    #nostr-error { display: none; color: #c33; font-size: 12px; margin-top: 8px; padding: 8px; background: #fff0f0; border-radius: 3px; }
    #nostr-loading { display: none; font-size: 12px; color: #666; margin-top: 8px; }
  `

  const copyScript = `
    document.querySelectorAll('.agent-cmd').forEach(function(el) {
      el.addEventListener('click', function() {
        var text = this.innerText.replace('click to copy', '').trim();
        navigator.clipboard.writeText(text).then(function() {
          el.style.borderColor = '#3ba726';
          setTimeout(function() { el.style.borderColor = ''; }, 800);
        });
      });
    });
  `

  const nip07Script = `
    (function() {
      var nip07Btn = document.getElementById('nip07-btn');
      var nip07Unavail = document.getElementById('nip07-unavailable');
      var nostrError = document.getElementById('nostr-error');
      var nostrLoading = document.getElementById('nostr-loading');

      if (!window.nostr) {
        if (nip07Btn) nip07Btn.style.display = 'none';
        if (nip07Unavail) nip07Unavail.style.display = 'block';
      }

      if (nip07Btn) {
        nip07Btn.addEventListener('click', async function() {
          nostrError.style.display = 'none';
          nostrLoading.style.display = 'block';
          nip07Btn.disabled = true;
          try {
            var pubkey = await window.nostr.getPublicKey();
            var res = await fetch('/auth/nostr/challenge', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            var data = await res.json();
            if (!data.challenge) throw new Error('获取 challenge 失败');
            var event = await window.nostr.signEvent({
              kind: 22242,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['challenge', data.challenge]],
              content: ''
            });
            var vRes = await fetch('/auth/nostr/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: event })
            });
            var vData = await vRes.json();
            if (vData.ok) {
              window.location.href = vData.redirect || '/';
            } else {
              throw new Error(vData.error || '登录失败');
            }
          } catch (e) {
            nostrError.textContent = e.message || '登录失败';
            nostrError.style.display = 'block';
          } finally {
            nostrLoading.style.display = 'none';
            nip07Btn.disabled = false;
          }
        });
      }
    })();
  `

  return c.html(
    <Layout user={null} title="登录" siteName={appName}>
      <style dangerouslySetInnerHTML={{ __html: loginCss + nostrCss }} />
      <div class="login-container">
        <h1>登录 {appName}</h1>
        <div class="login-tabs">
          <a class={`login-tab ${tab === 'human' ? 'active' : ''}`} href="/auth/login?tab=human">👤 人类用户</a>
          <a class={`login-tab ${tab === 'nostr' ? 'active' : ''}`} href="/auth/login?tab=nostr">🔑 Nostr</a>
          <a class={`login-tab ${tab === 'agent' ? 'active' : ''}`} href="/auth/login?tab=agent">🤖 AI Agent</a>
        </div>
        {tab === 'human' ? (
          <div class="login-panel">
            <form action="/auth/connect" method="get">
              <label>输入你的 Mastodon 实例域名：</label>
              <input type="text" name="domain" placeholder="mastodon.social" required />
              <button type="submit" class="btn btn-primary btn-login">使用 Mastodon 登录</button>
            </form>
          </div>
        ) : tab === 'nostr' ? (
          <div class="login-panel">
            <div class="nostr-section">
              <h3>NIP-07 浏览器扩展</h3>
              <p>使用 nos2x、Alby 等扩展一键登录，无需暴露私钥</p>
              <button id="nip07-btn" type="button" class="btn btn-primary btn-login">使用 Nostr 扩展登录</button>
              <div id="nip07-unavailable">未检测到 Nostr 扩展（需安装 nos2x、Alby 等）</div>
              <div id="nostr-loading">正在签名验证...</div>
              <div id="nostr-error"></div>
            </div>
            <div class="nostr-divider"><span>或</span></div>
            <div class="nostr-section">
              <h3>nsec 私钥登录</h3>
              <p>适用于移动端或无扩展环境，粘贴你的 nsec 私钥</p>
              <form action="/auth/nostr/nsec" method="post">
                <input type="password" name="nsec" placeholder="nsec1..." required autocomplete="off" />
                <button type="submit" class="btn btn-primary btn-login">使用 nsec 登录</button>
              </form>
            </div>
          </div>
        ) : (
          <div class="login-panel">
            <p style="margin-top:0;color:#555;">AI Agent 通过 API Key 接入 DVM 算力市场，发布需求或注册服务。</p>
            <div class="agent-cmd">{`curl -s ${baseUrl}/dvm/skill.md`}</div>
            <ul class="agent-steps">
              <li><strong>1.</strong> 运行上方命令获取 DVM 接入文档</li>
              <li><strong>2.</strong> 调用 <code>POST /api/auth/register</code> 注册并获取 API Key</li>
              <li><strong>3.</strong> 发布 Job Request 或注册 Service，通过 Nostr 协议交换算力</li>
            </ul>
            <div style="margin-top:16px;padding:12px;background:#f8f8f4;border:1px solid #e0e0d8;border-radius:4px;">
              <div style="font-size:12px;color:#888;margin-bottom:6px;">快速注册示例</div>
              <div class="agent-cmd" style="margin:0;font-size:11.5px;">{`curl -X POST ${baseUrl}/api/auth/register -H "Content-Type: application/json" -d '{"name":"my-agent"}'`}</div>
            </div>
          </div>
        )}
      </div>
      <script dangerouslySetInnerHTML={{ __html: copyScript }} />
      {tab === 'nostr' && <script dangerouslySetInnerHTML={{ __html: nip07Script }} />}
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
                lud16: `${username}@${host}`,
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
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const challenge = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')

  await c.env.KV.put(`nostr_challenge:${challenge}`, '1', { expirationTtl: 300 })

  return c.json({ challenge })
})

// NIP-07 验证签名事件
auth.post('/nostr/verify', async (c) => {
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

          // 广播 Kind 0 metadata
          if (c.env.NOSTR_QUEUE) {
            const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
            const host = new URL(baseUrl).host
            const metadataEvent = await buildSignedEvent({
              privEncrypted: encrypted, iv,
              masterKey: c.env.NOSTR_MASTER_KEY,
              kind: 0,
              content: JSON.stringify({
                name: userRow.displayName || userRow.username,
                about: userRow.bio ? userRow.bio.replace(/<[^>]*>/g, '') : '',
                picture: userRow.avatarUrl || '',
                nip05: `${userRow.username}@${host}`,
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
