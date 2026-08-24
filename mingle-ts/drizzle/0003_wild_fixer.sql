CREATE TABLE `card_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_types_name_ci_unique` ON `card_types` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `card_types_project_idx` ON `card_types` (`project_id`);--> statement-breakpoint
CREATE TABLE `card_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`card_type_name` text NOT NULL,
	`is_deletion` integer DEFAULT false NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_versions_version_unique` ON `card_versions` (`card_id`,`version`);--> statement-breakpoint
CREATE INDEX `card_versions_card_idx` ON `card_versions` (`card_id`);--> statement-breakpoint
CREATE INDEX `card_versions_project_number_idx` ON `card_versions` (`project_id`,`number`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`card_type_id` integer NOT NULL,
	`version` integer NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_number_unique` ON `cards` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX `cards_project_idx` ON `cards` (`project_id`);--> statement-breakpoint
CREATE INDEX `cards_type_idx` ON `cards` (`card_type_id`);