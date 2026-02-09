CREATE TABLE "remote_group" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "local_group_id" TEXT NOT NULL UNIQUE REFERENCES "group"("id"),
  "actor_uri" TEXT NOT NULL UNIQUE,
  "inbox_url" TEXT NOT NULL,
  "shared_inbox_url" TEXT,
  "domain" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL
);

ALTER TABLE "group_member" ADD COLUMN "follow_status" TEXT;
