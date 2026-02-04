import { generateId } from '../lib/utils'

const SESSION_TTL = 60 * 60 * 24 * 7 // 7 days in seconds
const SESSION_PREFIX = 'session:'

export interface Session {
  userId: string
  createdAt: number
}

export async function createSession(kv: KVNamespace, userId: string): Promise<string> {
  const sessionId = generateId()
  const session: Session = {
    userId,
    createdAt: Date.now(),
  }
  await kv.put(
    SESSION_PREFIX + sessionId,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL }
  )
  return sessionId
}

export async function getSession(kv: KVNamespace, sessionId: string): Promise<Session | null> {
  const data = await kv.get(SESSION_PREFIX + sessionId)
  if (!data) return null
  try {
    return JSON.parse(data) as Session
  } catch {
    return null
  }
}

export async function deleteSession(kv: KVNamespace, sessionId: string): Promise<void> {
  await kv.delete(SESSION_PREFIX + sessionId)
}

export function getSessionIdFromCookie(cookie: string | null): string | null {
  if (!cookie) return null
  const match = cookie.match(/session=([^;]+)/)
  return match ? match[1] : null
}

export function createSessionCookie(sessionId: string): string {
  return `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`
}

export function createLogoutCookie(): string {
  return 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
}
