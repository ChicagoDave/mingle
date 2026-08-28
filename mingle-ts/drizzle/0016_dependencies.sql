CREATE TABLE `dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`desired_end_date` text NOT NULL,
	`raising_project_id` integer NOT NULL,
	`raising_card_number` integer NOT NULL,
	`raising_user_id` integer NOT NULL,
	`resolving_project_id` integer NOT NULL,
	`status` text DEFAULT 'NEW' NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependencies_number_unique` ON `dependencies` (`number`);--> statement-breakpoint
CREATE INDEX `dependencies_raising_idx` ON `dependencies` (`raising_project_id`,`raising_card_number`);--> statement-breakpoint
CREATE INDEX `dependencies_resolving_idx` ON `dependencies` (`resolving_project_id`);--> statement-breakpoint
CREATE TABLE `dependency_resolving_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dependency_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`card_number` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_resolving_cards_unique` ON `dependency_resolving_cards` (`dependency_id`,`card_number`);--> statement-breakpoint
CREATE INDEX `dependency_resolving_cards_card_idx` ON `dependency_resolving_cards` (`project_id`,`card_number`);--> statement-breakpoint
CREATE TABLE `dependency_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dependency_id` integer NOT NULL,
	`number` integer NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`desired_end_date` text NOT NULL,
	`raising_project_id` integer NOT NULL,
	`raising_card_number` integer NOT NULL,
	`raising_user_id` integer NOT NULL,
	`resolving_project_id` integer NOT NULL,
	`status` text NOT NULL,
	`resolving_card_numbers` text DEFAULT '[]' NOT NULL,
	`is_deletion` integer DEFAULT false NOT NULL,
	`modified_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_versions_version_unique` ON `dependency_versions` (`dependency_id`,`version`);--> statement-breakpoint
CREATE INDEX `dependency_versions_dependency_idx` ON `dependency_versions` (`dependency_id`);--> statement-breakpoint
CREATE INDEX `dependency_versions_raising_idx` ON `dependency_versions` (`raising_project_id`);--> statement-breakpoint
CREATE INDEX `dependency_versions_resolving_idx` ON `dependency_versions` (`resolving_project_id`);--> statement-breakpoint
ALTER TABLE `history_subscriptions` ADD `last_dependency_version_id` integer DEFAULT 0 NOT NULL;