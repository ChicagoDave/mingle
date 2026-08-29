CREATE TABLE `pull_request_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`github_integration_id` integer NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`author_login` text,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_request_links_unique` ON `pull_request_links` (`github_integration_id`,`number`,`card_id`);--> statement-breakpoint
CREATE INDEX `pull_request_links_card_idx` ON `pull_request_links` (`card_id`);--> statement-breakpoint
ALTER TABLE `commit_links` ADD `status_state` text;--> statement-breakpoint
ALTER TABLE `commit_links` ADD `status_context` text;--> statement-breakpoint
ALTER TABLE `commit_links` ADD `status_description` text;--> statement-breakpoint
ALTER TABLE `commit_links` ADD `status_url` text;--> statement-breakpoint
ALTER TABLE `commit_links` ADD `status_at` integer;--> statement-breakpoint
ALTER TABLE `github_integrations` ADD `provider` text DEFAULT 'github' NOT NULL;