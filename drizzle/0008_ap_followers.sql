CREATE TABLE ap_follower (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  actor_uri TEXT NOT NULL,
  inbox_url TEXT NOT NULL,
  shared_inbox_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ap_follower_unique ON ap_follower(user_id, actor_uri);
