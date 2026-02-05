import type { Database } from './db'

export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  APP_URL: string
  APP_NAME: string
  R2?: R2Bucket
  QUEUE?: Queue
  AI?: Ai
  MASTODON_BOT_TOKEN?: string
  MASTODON_BOT_DOMAIN?: string
}

export type Variables = {
  db: Database
  user: import('./db/schema').User | null
  sessionId: string | null
  unreadNotificationCount: number
}

export type AppContext = {
  Bindings: Bindings
  Variables: Variables
}
