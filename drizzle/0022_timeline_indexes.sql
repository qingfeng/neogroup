-- Indexes for Timeline query performance
CREATE INDEX IF NOT EXISTS idx_user_follow_follower ON user_follow(follower_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_follow_followee ON user_follow(followee_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_group_member_user ON group_member(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_user_updated ON topic(user_id, updated_at);
