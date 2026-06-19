PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`opencode_version` text NOT NULL,
	`model` text NOT NULL,
	`cwd` text NOT NULL,
	`branch` text NOT NULL,
	`initial_prompt` text NOT NULL,
	`opencode_session_id` text,
	`transcript` text DEFAULT '[]' NOT NULL,
	`diff` text DEFAULT '[]' NOT NULL,
	`files_changed` text DEFAULT '[]' NOT NULL,
	`exit_code` integer,
	`exit_reason` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`pid` integer,
	`server_port` integer,
	`approved` integer,
	`revision_note` text
);
--> statement-breakpoint
INSERT INTO `__new_session`("id", "ticket_id", "opencode_version", "model", "cwd", "branch", "initial_prompt", "opencode_session_id", "transcript", "diff", "files_changed", "exit_code", "exit_reason", "prompt_tokens", "completion_tokens", "total_tokens", "cost_usd", "created_at", "ended_at", "duration_ms", "pid", "server_port", "approved", "revision_note") SELECT "id", "ticket_id", "opencode_version", "model", "cwd", "branch", "initial_prompt", "opencode_session_id", "transcript", "diff", "files_changed", "exit_code", "exit_reason", "prompt_tokens", "completion_tokens", "total_tokens", "cost_usd", "created_at", "ended_at", "duration_ms", "pid", "server_port", "approved", "revision_note" FROM `session`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
ALTER TABLE `__new_session` RENAME TO `session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;