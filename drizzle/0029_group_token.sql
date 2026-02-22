-- group_token: Token 定义（每组最多一种）
CREATE TABLE group_token (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL UNIQUE REFERENCES "group"(id),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL UNIQUE,
  icon_url TEXT NOT NULL,
  total_supply INTEGER NOT NULL DEFAULT 0,
  mined_total INTEGER NOT NULL DEFAULT 0,
  admin_allocation_pct INTEGER NOT NULL DEFAULT 0,
  airdrop_per_member INTEGER NOT NULL DEFAULT 0,
  reward_post INTEGER NOT NULL DEFAULT 0,
  reward_reply INTEGER NOT NULL DEFAULT 0,
  reward_like INTEGER NOT NULL DEFAULT 0,
  reward_liked INTEGER NOT NULL DEFAULT 0,
  daily_reward_cap INTEGER NOT NULL DEFAULT 0,
  airdrop_on_join INTEGER NOT NULL DEFAULT 0,
  airdrop_weighted INTEGER NOT NULL DEFAULT 0,
  halving_interval INTEGER NOT NULL DEFAULT 0,
  halving_ratio INTEGER NOT NULL DEFAULT 50,
  vesting_months INTEGER NOT NULL DEFAULT 0,
  vesting_start_at INTEGER,
  admin_vested_total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_group_token_group ON group_token(group_id);
--> statement-breakpoint

-- token_balance: 用户持有余额
CREATE TABLE token_balance (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  token_id TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'local',
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_balance_user_token ON token_balance(user_id, token_id, token_type);
--> statement-breakpoint

-- token_tx: 交易记录
CREATE TABLE token_tx (
  id TEXT PRIMARY KEY NOT NULL,
  token_id TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'local',
  from_user_id TEXT,
  to_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref_id TEXT,
  ref_type TEXT,
  memo TEXT,
  remote_actor_uri TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_token_tx_to_user ON token_tx(to_user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_token_tx_token ON token_tx(token_id, type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_token_tx_ref ON token_tx(ref_id, type);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_tx_dedup ON token_tx(token_id, to_user_id, type, ref_id) WHERE ref_id IS NOT NULL;
--> statement-breakpoint

-- remote_token: 远程 Token 镜像
CREATE TABLE remote_token (
  id TEXT PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  icon_url TEXT,
  origin_domain TEXT NOT NULL,
  origin_group_actor TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_token_symbol_domain ON remote_token(symbol, origin_domain);
