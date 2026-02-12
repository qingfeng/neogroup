-- 用户余额字段
ALTER TABLE "user" ADD COLUMN balance_sats INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- 账本表
CREATE TABLE ledger_entry (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  type TEXT NOT NULL,
  amount_sats INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_id TEXT,
  ref_type TEXT,
  memo TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entry(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_entry(type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entry(ref_id, ref_type);
