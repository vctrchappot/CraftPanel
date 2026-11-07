CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`username` text,
	`action` text NOT NULL,
	`target` text,
	`details` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`filename` text NOT NULL,
	`storage` text DEFAULT 'local' NOT NULL,
	`storage_key` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`note` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `backups_server_idx` ON `backups` (`server_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text,
	`kind` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`actor` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_server_idx` ON `events` (`server_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `player_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`uuid` text,
	`ip` text,
	`joined_at` integer NOT NULL,
	`left_at` integer
);
--> statement-breakpoint
CREATE INDEX `player_sessions_server_idx` ON `player_sessions` (`server_id`,`joined_at`);--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schedule_id` text NOT NULL,
	`slot` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`output` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_runs_slot_idx` ON `schedule_runs` (`schedule_id`,`slot`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`action` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`edition` text DEFAULT 'java' NOT NULL,
	`software` text NOT NULL,
	`mc_version` text NOT NULL,
	`build` text,
	`jar_file` text,
	`jar_sha` text,
	`java_major` integer NOT NULL,
	`java_path` text,
	`memory_mb` integer NOT NULL,
	`jvm_args` text DEFAULT '' NOT NULL,
	`directory` text NOT NULL,
	`port` integer NOT NULL,
	`network_mode` text DEFAULT 'lan' NOT NULL,
	`bind_address` text DEFAULT '' NOT NULL,
	`eula_accepted` integer DEFAULT false NOT NULL,
	`eula_accepted_at` integer,
	`auto_start` integer DEFAULT false NOT NULL,
	`install_state` text DEFAULT 'pending' NOT NULL,
	`install_error` text,
	`last_status` text DEFAULT 'stopped' NOT NULL,
	`desired_running` integer DEFAULT false NOT NULL,
	`pid` integer,
	`started_at` integer,
	`last_exit_code` integer,
	`last_error` text,
	`max_players` integer DEFAULT 20 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_idx` ON `users` (`username`);