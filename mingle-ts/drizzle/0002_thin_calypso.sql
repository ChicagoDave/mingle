CREATE TABLE `group_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_memberships_user_unique` ON `group_memberships` (`group_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `group_memberships_group_idx` ON `group_memberships` (`group_id`);--> statement-breakpoint
CREATE INDEX `group_memberships_user_idx` ON `group_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_ci_unique` ON `groups` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `groups_project_idx` ON `groups` (`project_id`);--> statement-breakpoint
CREATE TABLE `team_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_memberships_user_unique` ON `team_memberships` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_memberships_project_idx` ON `team_memberships` (`project_id`);--> statement-breakpoint
CREATE INDEX `team_memberships_user_idx` ON `team_memberships` (`user_id`);