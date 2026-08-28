CREATE TABLE `tree_belongings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tree_configuration_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tree_belongings_unique` ON `tree_belongings` (`tree_configuration_id`,`card_id`);--> statement-breakpoint
CREATE INDEX `tree_belongings_card_idx` ON `tree_belongings` (`card_id`);--> statement-breakpoint
CREATE TABLE `tree_card_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tree_configuration_id` integer NOT NULL,
	`card_type_id` integer NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tree_card_types_type_unique` ON `tree_card_types` (`tree_configuration_id`,`card_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tree_card_types_position_unique` ON `tree_card_types` (`tree_configuration_id`,`position`);--> statement-breakpoint
CREATE TABLE `tree_configurations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tree_configurations_name_ci_unique` ON `tree_configurations` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `tree_configurations_project_idx` ON `tree_configurations` (`project_id`);--> statement-breakpoint
ALTER TABLE `property_definitions` ADD `tree_configuration_id` integer;--> statement-breakpoint
ALTER TABLE `property_definitions` ADD `valid_card_type_id` integer;