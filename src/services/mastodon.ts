import type { Database } from '../db'
import { mastodonApps } from '../db/schema'
import { eq } from 'drizzle-orm'
import { generateId } from '../lib/utils'

const SCOPES = 'read:accounts read:search write:statuses write:media'

export interface MastodonAccount {
  id: string
  username: string
  acct: string
  display_name: string
  avatar: string
  note: string
  url: string
}

export interface MastodonToken {
  access_token: string
  token_type: string
  scope: string
  created_at: number
  refresh_token?: string
}

// 获取或创建 Mastodon 应用
// domain: mastodon 实例域名
// appUrl: 我们的应用 URL (包含协议和域名)
export async function getOrCreateApp(
  db: Database,
  domain: string,
  appName: string,
  appUrl: string
): Promise<{ clientId: string; clientSecret: string }> {
  // 组合 key: mastodon域名:我们的域名
  const ourHost = new URL(appUrl).host
  const lookupDomain = `${domain}:${ourHost}`

  // 检查是否已存在
  const existing = await db.query.mastodonApps.findFirst({
    where: eq(mastodonApps.domain, lookupDomain),
  })

  if (existing) {
    return {
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
    }
  }

  // 创建新应用
  const response = await fetch(`https://${domain}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: appName,
      redirect_uris: `${appUrl}/auth/callback`,
      scopes: SCOPES,
      website: appUrl,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create Mastodon app: ${response.statusText}`)
  }

  const data = await response.json() as {
    client_id: string
    client_secret: string
    vapid_key?: string
  }

  // 保存到数据库 (使用组合 key)
  await db.insert(mastodonApps).values({
    id: generateId(),
    domain: lookupDomain,
    clientId: data.client_id,
    clientSecret: data.client_secret,
    vapidKey: data.vapid_key || null,
    createdAt: new Date(),
  })

  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
  }
}

// 生成授权 URL
export function getAuthorizationUrl(
  domain: string,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
  })
  return `https://${domain}/oauth/authorize?${params.toString()}`
}

// 用授权码换取 token
export async function exchangeCodeForToken(
  domain: string,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<MastodonToken> {
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      scope: SCOPES,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to exchange code: ${response.statusText}`)
  }

  return response.json() as Promise<MastodonToken>
}

// 验证 token 并获取用户信息
export async function verifyCredentials(
  domain: string,
  accessToken: string
): Promise<MastodonAccount> {
  const response = await fetch(`https://${domain}/api/v1/accounts/verify_credentials`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to verify credentials: ${response.statusText}`)
  }

  return response.json() as Promise<MastodonAccount>
}

// 发布 Toot
export async function postStatus(
  domain: string,
  accessToken: string,
  status: string,
  visibility: 'public' | 'unlisted' | 'private' | 'direct' = 'public',
  inReplyToId?: string
): Promise<{ id: string; url: string }> {
  const body: Record<string, string> = { status, visibility }
  if (inReplyToId) body.in_reply_to_id = inReplyToId

  const response = await fetch(`https://${domain}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Failed to post status: ${response.statusText}`)
  }

  return response.json() as Promise<{ id: string; url: string }>
}

// 转发（reblog/boost）一条 status
export async function reblogStatus(
  domain: string,
  accessToken: string,
  statusId: string
): Promise<{ id: string }> {
  const response = await fetch(`https://${domain}/api/v1/statuses/${statusId}/reblog`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to reblog status: ${response.statusText}`)
  }

  return response.json() as Promise<{ id: string }>
}

// 通过 URL 搜索并 resolve 一条 status，返回本实例的 status ID
export async function resolveStatusByUrl(
  domain: string,
  accessToken: string,
  url: string
): Promise<string | null> {
  try {
    const searchRes = await fetch(
      `https://${domain}/api/v2/search?q=${encodeURIComponent(url)}&type=statuses&resolve=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!searchRes.ok) return null
    const data = await searchRes.json() as { statuses?: { id: string }[] }
    return data.statuses?.[0]?.id || null
  } catch {
    return null
  }
}

// 解析跨实例账号，确保本实例知道该用户（让 @ 变成真正的 mention）
export async function resolveAccount(
  userDomain: string,
  userToken: string,
  acct: string  // 格式: username@domain
): Promise<void> {
  try {
    await fetch(
      `https://${userDomain}/api/v2/search?q=${encodeURIComponent(acct)}&type=accounts&resolve=true&limit=1`,
      { headers: { Authorization: `Bearer ${userToken}` } }
    )
  } catch {
    // ignore errors
  }
}

// 解析跨实例 status ID（用于回复其他实例的 toot）
export async function resolveStatusId(
  userDomain: string,
  userToken: string,
  targetDomain: string,
  targetStatusId: string
): Promise<string | null> {
  if (userDomain === targetDomain) return targetStatusId

  try {
    const statusRes = await fetch(`https://${targetDomain}/api/v1/statuses/${targetStatusId}`)
    if (!statusRes.ok) return null
    const status = await statusRes.json() as { url: string }

    const searchRes = await fetch(
      `https://${userDomain}/api/v2/search?q=${encodeURIComponent(status.url)}&type=statuses&resolve=true`,
      { headers: { Authorization: `Bearer ${userToken}` } }
    )
    if (!searchRes.ok) return null
    const data = await searchRes.json() as { statuses?: { id: string }[] }
    return data.statuses?.[0]?.id || null
  } catch {
    return null
  }
}
