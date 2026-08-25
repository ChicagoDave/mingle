CREATE TABLE `transition_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transition_id` integer NOT NULL,
	`property_definition_id` integer NOT NULL,
	`input_mode` text DEFAULT 'fixed' NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transition_actions_property_unique` ON `transition_actions` (`transition_id`,`property_definition_id`);--> statement-breakpoint
CREATE INDEX `transition_actions_definition_idx` ON `transition_actions` (`property_definition_id`);--> statement-breakpoint
CREATE TABLE `transition_prerequisites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transition_id` integer NOT NULL,
	`kind` text NOT NULL,
	`property_definition_id` integer,
	`value` text,
	`user_id` integer,
	`group_id` integer
);
--> statement-breakpoint
CREATE INDEX `transition_prerequisites_transition_idx` ON `transition_prerequisites` (`transition_id`);--> statement-breakpoint
CREATE INDEX `transition_prerequisites_definition_idx` ON `transition_prerequisites` (`property_definition_id`);--> statement-breakpoint
CREATE TABLE `transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`card_type_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transitions_name_ci_unique` ON `transitions` (`project_id`,lower("name"));--> statement-breakpoint
CREATE INDEX `transitions_project_idx` ON `transitions` (`project_id`);