-- Migration: Add actor_uri and fix actor_id constraint for remote AP notifications
-- This allows storing remote ActivityPub actors in notifications

-- Step 1: Add actor_uri column for remote AP actors
ALTER TABLE notification ADD COLUMN actor_uri TEXT;

-- Step 2: Recreate notification table without FK constraint on actor_id
-- SQLite doesn't support dropping constraints, so we need to recreate the table

-- Create new table without actor_id FK constraint
CREATE TABLE notification_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id),
  actor_id TEXT,  -- nullable, no FK constraint for remote actors
  type TEXT NOT NULL,
  topic_id TEXT,
  comment_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  actor_name TEXT,
  actor_url TEXT,
  actor_avatar_url TEXT,
  metadata TEXT,
  actor_uri TEXT  -- new: stores AP actor URI for remote users
);

-- Copy data from old table
INSERT INTO notification_new 
SELECT id, user_id, actor_id, type, topic_id, comment_id, is_read, created_at, 
       actor_name, actor_url, actor_avatar_url, metadata, actor_uri
FROM notification;

-- Drop old table
DROP TABLE notification;

-- Rename new table
ALTER TABLE notification_new RENAME TO notification;

-- Recreate index
CREATE INDEX idx_notification_user_read ON notification(user_id, is_read, created_at);
