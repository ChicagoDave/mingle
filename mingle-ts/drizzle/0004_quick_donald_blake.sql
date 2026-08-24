CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`card_version` integer NOT NULL,
	`file_name` text NOT NULL,
	`file_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_file_key_unique` ON `attachments` (`file_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_file_name_ci_unique` ON `attachments` (`project_id`,lower("file_name"));--> statement-breakpoint
CREATE INDEX `attachments_card_idx` ON `attachments` (`card_id`);--> statement-breakpoint
CREATE INDEX `attachments_project_idx` ON `attachments` (`project_id`);--> statement-breakpoint
CREATE TABLE `card_checklist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`text` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `card_checklist_items_card_idx` ON `card_checklist_items` (`card_id`);