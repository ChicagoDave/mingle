CREATE TABLE `program_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_memberships_user_unique` ON `program_memberships` (`program_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `program_memberships_program_idx` ON `program_memberships` (`program_id`);--> statement-breakpoint
CREATE INDEX `program_memberships_user_idx` ON `program_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `objective_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`objective_id` integer NOT NULL,
	`program_id` integer NOT NULL,
	`number` integer NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`value_statement` text,
	`start_at` text,
	`end_at` text,
	`vertical_position` integer NOT NULL,
	`size` integer NOT NULL,
	`value` integer NOT NULL,
	`status` text NOT NULL,
	`position` integer NOT NULL,
	`is_deletion` integer DEFAULT false NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `objective_versions_version_unique` ON `objective_versions` (`objective_id`,`version`);--> statement-breakpoint
CREATE INDEX `objective_versions_objective_idx` ON `objective_versions` (`objective_id`);--> statement-breakpoint
CREATE INDEX `objective_versions_program_idx` ON `objective_versions` (`program_id`);--> statement-breakpoint
CREATE TABLE `objectives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`value_statement` text,
	`start_at` text,
	`end_at` text,
	`vertical_position` integer DEFAULT 6 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'PLANNED' NOT NULL,
	`position` integer NOT NULL,
	`version` integer NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `objectives_number_unique` ON `objectives` (`program_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `objectives_name_ci_unique` ON `objectives` (`program_id`,lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX `objectives_identifier_unique` ON `objectives` (`program_id`,`identifier`);--> statement-breakpoint
CREATE INDEX `objectives_program_status_idx` ON `objectives` (`program_id`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`precision` integer DEFAULT 2 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_program_unique` ON `plans` (`program_id`);--> statement-breakpoint
CREATE TABLE `program_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_projects_unique` ON `program_projects` (`program_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `program_projects_project_idx` ON `program_projects` (`project_id`);--> statement-breakpoint
CREATE TABLE `programs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`identifier` text NOT NULL,
	`description` text,
	`created_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `programs_identifier_unique` ON `programs` (`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `programs_name_ci_unique` ON `programs` (lower("name"));