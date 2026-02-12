-- DVM Job: NIP-90 任务（Customer 和 Provider 共用）
CREATE TABLE dvm_job (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  role TEXT NOT NULL,
  kind INTEGER NOT NULL,
  event_id TEXT,
  status TEXT NOT NULL,
  input TEXT,
  input_type TEXT,
  output TEXT,
  result TEXT,
  bid_msats INTEGER,
  price_msats INTEGER,
  customer_pubkey TEXT,
  provider_pubkey TEXT,
  request_event_id TEXT,
  result_event_id TEXT,
  params TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dvm_job_user ON dvm_job(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dvm_job_status ON dvm_job(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dvm_job_event_id ON dvm_job(event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dvm_job_request_event_id ON dvm_job(request_event_id);
--> statement-breakpoint

-- DVM Service: 服务注册（NIP-89）
CREATE TABLE dvm_service (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  kinds TEXT NOT NULL,
  description TEXT,
  pricing_min INTEGER,
  pricing_max INTEGER,
  event_id TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dvm_service_user ON dvm_service(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dvm_service_active ON dvm_service(active);
