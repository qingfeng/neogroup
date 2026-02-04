import type { Database } from './db'

export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  APP_URL: string
  APP_NAME: string
  // 阶段二才需要
  R2?: R2Bucket
  QUEUE?: Queue
}

export type Variables = {
  db: Database
  user: import('./db/schema').User | null
  sessionId: string | null
}

export type AppContext = {
  Bindings: Bindings
  Variables: Variables
}
