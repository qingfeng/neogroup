-- 充值发票表
CREATE TABLE deposit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  amount_sats INTEGER NOT NULL,
  payment_hash TEXT UNIQUE NOT NULL,
  payment_request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deposit_user ON deposit(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deposit_hash ON deposit(payment_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deposit_status ON deposit(status);
