CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`dedupe_key` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`run_at` integer NOT NULL,
	`locked_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_pending_dedupe_unique` ON `jobs` (`dedupe_key`) WHERE "jobs"."status" = 'pending' AND "jobs"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `history_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`card_number` integer,
	`page_identifier` text,
	`mql` text,
	`filter_key` text NOT NULL,
	`last_card_version_id` integer DEFAULT 0 NOT NULL,
	`last_page_version_id` integer DEFAULT 0 NOT NULL,
	`last_murmur_id` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_subscriptions_unique` ON `history_subscriptions` (`user_id`,`project_id`,`filter_key`);--> statement-breakpoint
CREATE INDEX `history_subscriptions_project_idx` ON `history_subscriptions` (`project_id`);--> statement-breakpoint
CREATE INDEX `history_subscriptions_user_idx` ON `history_subscriptions` (`user_id`);