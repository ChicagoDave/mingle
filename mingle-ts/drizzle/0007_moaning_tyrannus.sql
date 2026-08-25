CREATE TABLE `favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`user_id` integer,
	`kind` text DEFAULT 'card_view' NOT NULL,
	`name` text NOT NULL,
	`tab_view` integer DEFAULT false NOT NULL,
	`style` text NOT NULL,
	`filters` text DEFAULT '[]' NOT NULL,
	`columns` text DEFAULT '[]' NOT NULL,
	`group_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `favorites_team_name_ci_unique` ON `favorites` (`project_id`,lower("name")) WHERE "favorites"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `favorites_personal_name_ci_unique` ON `favorites` (`project_id`,`user_id`,lower("name")) WHERE "favorites"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `favorites_project_idx` ON `favorites` (`project_id`);