CREATE TABLE `topic_like` (
  `id` text PRIMARY KEY NOT NULL,
  `topic_id` text NOT NULL REFERENCES `topic`(`id`),
  `user_id` text NOT NULL REFERENCES `user`(`id`),
  `created_at` integer NOT NULL
);
