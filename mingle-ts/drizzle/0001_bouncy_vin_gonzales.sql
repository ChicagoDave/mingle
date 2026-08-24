CREATE TABLE `project_variables` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`data_type` text NOT NULL,
	`value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_variables_name_ci_unique` ON `project_variables` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `project_variables_project_idx` ON `project_variables` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text,
	`created_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_identifier_unique` ON `projects` (`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_ci_unique` ON `projects` (lower("name"));