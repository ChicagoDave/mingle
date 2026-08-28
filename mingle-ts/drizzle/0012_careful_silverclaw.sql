CREATE TABLE `card_murmur_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`murmur_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_murmur_links_unique` ON `card_murmur_links` (`card_id`,`murmur_id`);--> statement-breakpoint
CREATE INDEX `card_murmur_links_card_idx` ON `card_murmur_links` (`card_id`);--> statement-breakpoint
CREATE TABLE `murmur_mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`murmur_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`user_id` integer NOT NULL,
	`group_id` integer,
	`mention_text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `murmur_mentions_user_unique` ON `murmur_mentions` (`murmur_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `murmur_mentions_user_idx` ON `murmur_mentions` (`user_id`);--> statement-breakpoint
CREATE INDEX `murmur_mentions_murmur_idx` ON `murmur_mentions` (`murmur_id`);--> statement-breakpoint
CREATE TABLE `murmurs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`body` text NOT NULL,
	`author_user_id` integer NOT NULL,
	`origin_type` text NOT NULL,
	`origin_card_id` integer,
	`origin_card_version` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `murmurs_project_created_idx` ON `murmurs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `murmurs_origin_card_idx` ON `murmurs` (`origin_card_id`);--> statement-breakpoint
ALTER TABLE `card_versions` ADD `comment` text;