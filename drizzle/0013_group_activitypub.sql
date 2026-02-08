-- Add ActivityPub fields to groups table for federation support
-- SQLite doesn't allow adding UNIQUE column directly, so we add without constraint first
ALTER TABLE "group" ADD COLUMN "actor_name" TEXT;
ALTER TABLE "group" ADD COLUMN "ap_public_key" TEXT;
ALTER TABLE "group" ADD COLUMN "ap_private_key" TEXT;

-- Create unique index for actor_name
CREATE UNIQUE INDEX IF NOT EXISTS "group_actor_name_unique" ON "group"("actor_name");

-- Create table for group followers (remote AP actors following groups)
CREATE TABLE IF NOT EXISTS "group_follower" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "group_id" TEXT NOT NULL REFERENCES "group"("id"),
  "actor_uri" TEXT NOT NULL,
  "actor_inbox" TEXT,
  "actor_shared_inbox" TEXT,
  "created_at" INTEGER NOT NULL
);

-- Create unique index for group_id + actor_uri combination
CREATE UNIQUE INDEX IF NOT EXISTS "group_follower_unique" ON "group_follower"("group_id", "actor_uri");
