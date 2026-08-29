CREATE TABLE `commit_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`github_integration_id` integer NOT NULL,
	`repository` text NOT NULL,
	`sha` text NOT NULL,
	`url` text NOT NULL,
	`author_name` text NOT NULL,
	`author_login` text,
	`message` text NOT NULL,
	`committed_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commit_links_card_sha_unique` ON `commit_links` (`card_id`,`sha`);--> statement-breakpoint
CREATE INDEX `commit_links_project_idx` ON `commit_links` (`project_id`);--> statement-breakpoint
CREATE TABLE `github_commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_integration_id` integer NOT NULL,
	`sha` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_commits_sha_unique` ON `github_commits` (`github_integration_id`,`sha`);--> statement-breakpoint
CREATE TABLE `github_integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`repository` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_received_at` integer,
	`created_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_integrations_repository_unique` ON `github_integrations` (`project_id`,`repository`);--> statement-breakpoint
CREATE INDEX `github_integrations_project_idx` ON `github_integrations` (`project_id`);--> statement-breakpoint
CREATE TABLE `slack_integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`webhook_url_sealed` text NOT NULL,
	`channel_label` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cursor` text NOT NULL,
	`last_delivered_at` integer,
	`last_error` text,
	`created_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_integrations_project_id_unique` ON `slack_integrations` (`project_id`);