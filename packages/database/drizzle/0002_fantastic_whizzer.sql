CREATE TABLE `server_members` (
	`user_id` text NOT NULL,
	`server_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_members_user_server_idx` ON `server_members` (`user_id`,`server_id`);--> statement-breakpoint
CREATE INDEX `server_members_server_idx` ON `server_members` (`server_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `server_scope` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `recovery_codes` text;