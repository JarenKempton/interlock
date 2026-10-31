CREATE TABLE `retirements` (
	`lane` text PRIMARY KEY NOT NULL,
	`run` text NOT NULL,
	`path` text NOT NULL,
	`repository` text NOT NULL,
	`branch` text NOT NULL,
	`plan_json` text NOT NULL,
	`phase` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retirements_run_unique` ON `retirements` (`run`);--> statement-breakpoint
CREATE UNIQUE INDEX `retirements_path_unique` ON `retirements` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `retirements_repository_branch` ON `retirements` (`repository`,`branch`);