-- Local user follow relationships
CREATE TABLE IF NOT EXISTS "user_follow" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "follower_id" TEXT NOT NULL REFERENCES "user"("id"),
  "followee_id" TEXT NOT NULL REFERENCES "user"("id"),
  "created_at" INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_follow_unique" ON "user_follow"("follower_id", "followee_id");
