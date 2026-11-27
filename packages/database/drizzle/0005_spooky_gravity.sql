CREATE TABLE `metric_buckets` (
	`server_id` text NOT NULL,
	`resolution` integer NOT NULL,
	`ts` integer NOT NULL,
	`cpu_sum` real DEFAULT 0 NOT NULL,
	`cpu_n` integer DEFAULT 0 NOT NULL,
	`cpu_max` real,
	`memory_sum` real DEFAULT 0 NOT NULL,
	`memory_n` integer DEFAULT 0 NOT NULL,
	`memory_max` real,
	`tps_sum` real DEFAULT 0 NOT NULL,
	`tps_n` integer DEFAULT 0 NOT NULL,
	`tps_min` real,
	`mspt_sum` real DEFAULT 0 NOT NULL,
	`mspt_n` integer DEFAULT 0 NOT NULL,
	`mspt_max` real,
	`players_sum` real DEFAULT 0 NOT NULL,
	`players_n` integer DEFAULT 0 NOT NULL,
	`players_max` integer,
	PRIMARY KEY(`server_id`, `resolution`, `ts`)
);
--> statement-breakpoint
CREATE INDEX `metric_buckets_age_idx` ON `metric_buckets` (`resolution`,`ts`);