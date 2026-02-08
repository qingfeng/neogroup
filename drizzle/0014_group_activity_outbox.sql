-- Store activities that group actors publish (outbox support)
CREATE TABLE IF NOT EXISTS "group_activity" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "group_id" TEXT NOT NULL REFERENCES "group"("id"),
  "activity_json" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "group_activity_group_idx" ON "group_activity"("group_id", "created_at");
