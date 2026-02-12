import type { Database } from './db'

export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  APP_URL: string
  APP_NAME: string
  R2?: R2Bucket
  QUEUE?: Queue
  NOSTR_QUEUE?: Queue
  AI?: Ai
  MASTODON_BOT_TOKEN?: string
  MASTODON_BOT_DOMAIN?: string
  NOSTR_MASTER_KEY?: string
  NOSTR_RELAYS?: string
  NOSTR_RELAY_URL?: string
  NOSTR_MIN_POW?: string
  LNBITS_URL?: string
  LNBITS_ADMIN_KEY?: string
  LNBITS_INVOICE_KEY?: string
  LNBITS_WEBHOOK_SECRET?: string
  SYSTEM_NOSTR_PUBKEY?: string
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
