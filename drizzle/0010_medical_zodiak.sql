ALTER TABLE `settings` ADD `gh_path` text DEFAULT 'gh' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `gh_token` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `default_remote` text DEFAULT 'origin' NOT NULL;