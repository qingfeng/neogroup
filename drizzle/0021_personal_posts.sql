-- Make topics.group_id nullable for personal posts (no group)
-- SQLite doesn't support ALTER COLUMN, so we rebuild the table

CREATE TABLE topic_new (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT REFERENCES "group"(id),
  user_id TEXT NOT NULL REFERENCES "user"(id),
  title TEXT NOT NULL,
  content TEXT,
  type INTEGER DEFAULT 0,
  images TEXT,
  mastodon_status_id TEXT,
  mastodon_domain TEXT,
  mastodon_synced_at INTEGER,
  nostr_event_id TEXT,
  nostr_author_pubkey TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO topic_new SELECT * FROM topic;
--> statement-breakpoint
DROP TABLE topic;
--> statement-breakpoint
ALTER TABLE topic_new RENAME TO topic;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_group_id ON topic(group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_user_id ON topic(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_nostr_event_id ON topic(nostr_event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_updated_at ON topic(updated_at);
