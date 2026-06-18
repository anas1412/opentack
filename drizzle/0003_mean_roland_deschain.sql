CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`forward_description` integer DEFAULT true NOT NULL,
	`theme` text DEFAULT 'amber' NOT NULL,
	`updated_at` integer NOT NULL
);
