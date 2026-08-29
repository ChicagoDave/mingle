CREATE TABLE `auth_configurations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`updated_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_configurations_kind_unique` ON `auth_configurations` (`kind`);--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_subject_unique` ON `external_identities` (`kind`,`subject`);--> statement-breakpoint
CREATE INDEX `external_identities_user_idx` ON `external_identities` (`user_id`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `signing_secret_sealed` text;