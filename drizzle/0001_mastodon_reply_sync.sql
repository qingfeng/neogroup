ALTER TABLE `topic` ADD COLUMN `mastodon_status_id` text;
--> statement-breakpoint
ALTER TABLE `topic` ADD COLUMN `mastodon_domain` text;
--> statement-breakpoint
ALTER TABLE `topic` ADD COLUMN `mastodon_synced_at` integer;
--> statement-breakpoint
ALTER TABLE `comment` ADD COLUMN `mastodon_status_id` text;
