CREATE TABLE `lanes` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket` text,
	`title` text,
	`run_ref` text,
	`claim_ref` text,
	`state` text NOT NULL,
	`previous_state` text,
	`attention_reason` text,
	`artifact` text,
	`head` text,
	`evidence_json` text NOT NULL,
	`verdict_json` text,
	`review_round` integer NOT NULL,
	`max_review_rounds` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
