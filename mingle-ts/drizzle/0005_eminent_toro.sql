CREATE TABLE `card_property_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`property_definition_id` integer NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_property_values_unique` ON `card_property_values` (`card_id`,`property_definition_id`);--> statement-breakpoint
CREATE INDEX `card_property_values_definition_idx` ON `card_property_values` (`property_definition_id`);--> statement-breakpoint
CREATE TABLE `enumeration_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`property_definition_id` integer NOT NULL,
	`value` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enumeration_values_value_ci_unique` ON `enumeration_values` (`property_definition_id`,lower("value"));--> statement-breakpoint
CREATE INDEX `enumeration_values_definition_idx` ON `enumeration_values` (`property_definition_id`);--> statement-breakpoint
CREATE TABLE `property_definitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `property_definitions_name_ci_unique` ON `property_definitions` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `property_definitions_project_idx` ON `property_definitions` (`project_id`);--> statement-breakpoint
ALTER TABLE `card_versions` ADD `property_values` text DEFAULT '{}' NOT NULL;