-- Dedupe imported remote AP/Mastodon objects, then prevent future same-group duplicates.
DROP TABLE IF EXISTS __remote_topic_keep;
--> statement-breakpoint
CREATE TABLE __remote_topic_keep AS
SELECT
  t.group_id,
  t.mastodon_status_id,
  (
    SELECT t2.id
    FROM topic t2
    WHERE t2.mastodon_status_id = t.mastodon_status_id
      AND (t2.group_id = t.group_id OR (t2.group_id IS NULL AND t.group_id IS NULL))
    ORDER BY
      (SELECT COUNT(*) FROM comment c WHERE c.topic_id = t2.id) DESC,
      (SELECT COUNT(*) FROM topic_like tl WHERE tl.topic_id = t2.id) DESC,
      (SELECT COUNT(*) FROM topic_repost tr WHERE tr.topic_id = t2.id) DESC,
      t2.created_at ASC,
      t2.id ASC
    LIMIT 1
  ) AS keep_id
FROM topic t
WHERE t.mastodon_status_id IS NOT NULL
GROUP BY t.group_id, t.mastodon_status_id
HAVING COUNT(*) > 1;
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_topic_dupe;
--> statement-breakpoint
CREATE TABLE __remote_topic_dupe AS
SELECT t.id AS duplicate_id, k.keep_id
FROM topic t
INNER JOIN __remote_topic_keep k
  ON t.mastodon_status_id = k.mastodon_status_id
  AND (t.group_id = k.group_id OR (t.group_id IS NULL AND k.group_id IS NULL))
WHERE t.id <> k.keep_id;
--> statement-breakpoint
UPDATE comment
SET topic_id = (
  SELECT keep_id FROM __remote_topic_dupe WHERE duplicate_id = comment.topic_id
)
WHERE topic_id IN (SELECT duplicate_id FROM __remote_topic_dupe);
--> statement-breakpoint
UPDATE topic_like
SET topic_id = (
  SELECT keep_id FROM __remote_topic_dupe WHERE duplicate_id = topic_like.topic_id
)
WHERE topic_id IN (SELECT duplicate_id FROM __remote_topic_dupe);
--> statement-breakpoint
UPDATE topic_repost
SET topic_id = (
  SELECT keep_id FROM __remote_topic_dupe WHERE duplicate_id = topic_repost.topic_id
)
WHERE topic_id IN (SELECT duplicate_id FROM __remote_topic_dupe);
--> statement-breakpoint
UPDATE notification
SET topic_id = (
  SELECT keep_id FROM __remote_topic_dupe WHERE duplicate_id = notification.topic_id
)
WHERE topic_id IN (SELECT duplicate_id FROM __remote_topic_dupe);
--> statement-breakpoint
DELETE FROM topic
WHERE id IN (SELECT duplicate_id FROM __remote_topic_dupe);
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_comment_keep;
--> statement-breakpoint
CREATE TABLE __remote_comment_keep AS
SELECT
  c.topic_id,
  c.mastodon_status_id,
  (
    SELECT c2.id
    FROM comment c2
    WHERE c2.topic_id = c.topic_id
      AND c2.mastodon_status_id = c.mastodon_status_id
    ORDER BY
      (SELECT COUNT(*) FROM comment_like cl WHERE cl.comment_id = c2.id) DESC,
      (SELECT COUNT(*) FROM comment_repost cr WHERE cr.comment_id = c2.id) DESC,
      c2.created_at ASC,
      c2.id ASC
    LIMIT 1
  ) AS keep_id
FROM comment c
WHERE c.mastodon_status_id IS NOT NULL
GROUP BY c.topic_id, c.mastodon_status_id
HAVING COUNT(*) > 1;
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_comment_dupe;
--> statement-breakpoint
CREATE TABLE __remote_comment_dupe AS
SELECT c.id AS duplicate_id, k.keep_id
FROM comment c
INNER JOIN __remote_comment_keep k
  ON c.topic_id = k.topic_id
  AND c.mastodon_status_id = k.mastodon_status_id
WHERE c.id <> k.keep_id;
--> statement-breakpoint
UPDATE comment
SET reply_to_id = (
  SELECT keep_id FROM __remote_comment_dupe WHERE duplicate_id = comment.reply_to_id
)
WHERE reply_to_id IN (SELECT duplicate_id FROM __remote_comment_dupe);
--> statement-breakpoint
UPDATE comment_like
SET comment_id = (
  SELECT keep_id FROM __remote_comment_dupe WHERE duplicate_id = comment_like.comment_id
)
WHERE comment_id IN (SELECT duplicate_id FROM __remote_comment_dupe);
--> statement-breakpoint
UPDATE comment_repost
SET comment_id = (
  SELECT keep_id FROM __remote_comment_dupe WHERE duplicate_id = comment_repost.comment_id
)
WHERE comment_id IN (SELECT duplicate_id FROM __remote_comment_dupe);
--> statement-breakpoint
UPDATE notification
SET comment_id = (
  SELECT keep_id FROM __remote_comment_dupe WHERE duplicate_id = notification.comment_id
)
WHERE comment_id IN (SELECT duplicate_id FROM __remote_comment_dupe);
--> statement-breakpoint
DELETE FROM comment
WHERE id IN (SELECT duplicate_id FROM __remote_comment_dupe);
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_topic_keep;
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_topic_dupe;
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_comment_keep;
--> statement-breakpoint
DROP TABLE IF EXISTS __remote_comment_dupe;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_remote_object_group
ON topic(group_id, mastodon_status_id)
WHERE group_id IS NOT NULL AND mastodon_status_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_remote_object_personal
ON topic(mastodon_status_id)
WHERE group_id IS NULL AND mastodon_status_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_remote_object_topic
ON comment(topic_id, mastodon_status_id)
WHERE mastodon_status_id IS NOT NULL;
