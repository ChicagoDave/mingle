ALTER TABLE `api_keys` ADD `previous_signing_secret_sealed` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `previous_secret_expires_at` integer;