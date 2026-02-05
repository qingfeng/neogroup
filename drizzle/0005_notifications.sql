CREATE TABLE `notification` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`),
  `actor_id` text NOT NULL REFERENCES `user`(`id`),
  `type` text NOT NULL,
  `topic_id` text,
  `comment_id` text,
  `is_read` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);

CREATE INDEX `idx_notification_user_read` ON `notification`(`user_id`, `is_read`, `created_at`);