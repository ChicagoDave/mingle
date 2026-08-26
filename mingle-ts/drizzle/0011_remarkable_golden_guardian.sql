CREATE TABLE `page_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`content` text,
	`is_deletion` integer DEFAULT false NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_versions_version_unique` ON `page_versions` (`page_id`,`version`);--> statement-breakpoint
CREATE INDEX `page_versions_page_idx` ON `page_versions` (`page_id`);--> statement-breakpoint
CREATE INDEX `page_versions_project_idx` ON `page_versions` (`project_id`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`content` text,
	`version` integer NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_name_ci_unique` ON `pages` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `pages_project_idx` ON `pages` (`project_id`);