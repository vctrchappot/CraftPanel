CREATE TABLE `host_metric_buckets` (
	`resolution` integer NOT NULL,
	`ts` integer NOT NULL,
	`cpu_sum` real DEFAULT 0 NOT NULL,
	`cpu_n` integer DEFAULT 0 NOT NULL,
	`cpu_max` real,
	`memory_used_sum` real DEFAULT 0 NOT NULL,
	`memory_used_n` integer DEFAULT 0 NOT NULL,
	`memory_used_max` real,
	`memory_total` real,
	`disk_used_sum` real DEFAULT 0 NOT NULL,
	`disk_used_n` integer DEFAULT 0 NOT NULL,
	`disk_used_max` real,
	`disk_total` real,
	PRIMARY KEY(`resolution`, `ts`)
);
