-- Nostr follow: track external Nostr users a local user follows
CREATE TABLE nostr_follow (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  target_pubkey TEXT NOT NULL,
  target_npub TEXT,
  target_display_name TEXT,
  target_avatar_url TEXT,
  last_poll_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_nostr_follow_user ON nostr_follow(user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_nostr_follow_unique ON nostr_follow(user_id, target_pubkey);
--> statement-breakpoint

-- Nostr community follow: track external NIP-72 communities a local user follows
CREATE TABLE nostr_community_follow (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  community_pubkey TEXT NOT NULL,
  community_d_tag TEXT NOT NULL,
  community_relay TEXT,
  community_name TEXT,
  local_group_id TEXT REFERENCES "group"(id),
  last_poll_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_nostr_community_follow_user ON nostr_community_follow(user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_nostr_community_follow_unique ON nostr_community_follow(user_id, community_pubkey, community_d_tag);
