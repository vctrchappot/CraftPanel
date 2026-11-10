CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`definition` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`sleeping` integer DEFAULT false NOT NULL,
	`last_triggered_at` integer,
	`last_result` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rules_server_idx` ON `rules` (`server_id`);