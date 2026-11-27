CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`server_id` text,
	`title` text NOT NULL,
	`actor` text,
	`state` text NOT NULL,
	`stage` text,
	`percent` integer,
	`error` text,
	`hint` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`);--> statement-breakpoint
CREATE INDEX `jobs_server_idx` ON `jobs` (`server_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `jobs_started_idx` ON `jobs` (`started_at`);