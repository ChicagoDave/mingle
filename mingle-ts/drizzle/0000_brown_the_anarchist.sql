CREATE TABLE `domain_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` integer NOT NULL,
	`payload` text NOT NULL,
	`actor_user_id` integer,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_events_aggregate_idx` ON `domain_events` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`login` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`password_hash` text NOT NULL,
	`admin` integer DEFAULT false NOT NULL,
	`activated` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_unique` ON `users` (`login`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_ci_unique` ON `users` (lower("email")) WHERE "users"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `users_last_login_idx` ON `users` (`last_login_at`);