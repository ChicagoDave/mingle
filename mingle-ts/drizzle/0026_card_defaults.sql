CREATE TABLE `card_defaults` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`card_type_id` integer NOT NULL,
	`property_definition_id` integer NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_defaults_unique` ON `card_defaults` (`card_type_id`,`property_definition_id`);--> statement-breakpoint
CREATE INDEX `card_defaults_project_idx` ON `card_defaults` (`project_id`);