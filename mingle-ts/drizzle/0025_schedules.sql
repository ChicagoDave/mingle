CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`job_type` text NOT NULL,
	`cron` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_outcome` text,
	`last_error` text,
	`last_finished_at` integer,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_key_unique` ON `schedules` (`key`);--> statement-breakpoint
ALTER TABLE `users` ADD `time_zone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
INSERT INTO `schedules` (`key`, `name`, `job_type`, `cron`, `enabled`, `updated_at`, `created_at`) VALUES ('backup', 'Nightly backup', 'backup', '0 3 * * *', false, (CAST(strftime('%s','now') AS INTEGER) * 1000), (CAST(strftime('%s','now') AS INTEGER) * 1000));
