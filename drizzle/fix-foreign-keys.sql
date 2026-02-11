-- Fix foreign keys: comment, topic_like, topic_repost still reference topic_old instead of topic
-- SQLite requires table recreation to change foreign key references

PRAGMA foreign_keys=OFF;

-- 1. Fix comment table
CREATE TABLE "comment_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "topic_id" TEXT NOT NULL REFERENCES "topic"("id"),
  "user_id" TEXT NOT NULL REFERENCES "user"("id"),
  "content" TEXT NOT NULL,
  "reply_to_id" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "mastodon_status_id" TEXT,
  "mastodon_domain" TEXT,
  "mastodon_synced_at" INTEGER,
  "nostr_event_id" TEXT
);
INSERT INTO "comment_new" SELECT * FROM "comment";
DROP TABLE "comment";
ALTER TABLE "comment_new" RENAME TO "comment";

-- 2. Fix topic_like table
CREATE TABLE "topic_like_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "topic_id" TEXT NOT NULL REFERENCES "topic"("id"),
  "user_id" TEXT NOT NULL REFERENCES "user"("id"),
  "created_at" INTEGER NOT NULL
);
INSERT INTO "topic_like_new" SELECT * FROM "topic_like";
DROP TABLE "topic_like";
ALTER TABLE "topic_like_new" RENAME TO "topic_like";

-- 3. Fix topic_repost table
CREATE TABLE "topic_repost_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "topic_id" TEXT NOT NULL REFERENCES "topic"("id"),
  "user_id" TEXT NOT NULL REFERENCES "user"("id"),
  "created_at" INTEGER NOT NULL
);
INSERT INTO "topic_repost_new" SELECT * FROM "topic_repost";
DROP TABLE "topic_repost";
ALTER TABLE "topic_repost_new" RENAME TO "topic_repost";

-- 4. Drop the old topic_old table (no longer needed)
DROP TABLE IF EXISTS "topic_old";

PRAGMA foreign_keys=ON;
