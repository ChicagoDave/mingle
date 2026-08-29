CREATE TABLE `slack_event_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`event_type` text NOT NULL,
	`slack_integration_id` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_event_routes_type_unique` ON `slack_event_routes` (`project_id`,`event_type`);--> statement-breakpoint
DROP INDEX `slack_integrations_project_id_unique`;--> statement-breakpoint
ALTER TABLE `slack_integrations` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `slack_integrations_project_idx` ON `slack_integrations` (`project_id`);--> statement-breakpoint
UPDATE `slack_integrations` SET `is_default` = true;
