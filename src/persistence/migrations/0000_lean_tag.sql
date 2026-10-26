CREATE TABLE `claims` (
	`ref` text PRIMARY KEY NOT NULL,
	`ticket` text NOT NULL,
	`human_owner` text NOT NULL,
	`run_ref` text NOT NULL,
	`previous_state_json` text NOT NULL,
	`claimed_at` text NOT NULL,
	`lease_expires_at` text NOT NULL,
	`status` text NOT NULL,
	`current_version` text,
	`supersedes` text,
	`superseded_by` text,
	FOREIGN KEY (`run_ref`) REFERENCES `runs`(`ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `configuration_overrides` (
	`project_path` text PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `execution_configurations` (
	`run_ref` text PRIMARY KEY NOT NULL,
	`snapshot_json` text NOT NULL,
	FOREIGN KEY (`run_ref`) REFERENCES `runs`(`ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recovery_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_ref` text NOT NULL,
	`outcome` text NOT NULL,
	`evidence_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`run_ref`) REFERENCES `runs`(`ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`ref` text PRIMARY KEY NOT NULL,
	`ticket` text NOT NULL,
	`harness` text NOT NULL,
	`model` text,
	`effort` text,
	`context` text,
	`workspace_json` text NOT NULL,
	`capabilities_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`execution_json` text
);
--> statement-breakpoint
CREATE TABLE `transaction_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_ref` text NOT NULL,
	`state` text NOT NULL,
	`receipt_json` text,
	`error_text` text,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`run_ref`) REFERENCES `runs`(`ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
