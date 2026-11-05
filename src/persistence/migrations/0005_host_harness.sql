ALTER TABLE `runs` ADD `host` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
update "runs" set "host" = 't3', "harness" = case when coalesce(((select case when json_valid("receipt_json") then json_extract("receipt_json", '$.plan.modelSelection.provider') end from "transaction_steps" where ("transaction_steps"."run_ref" = "runs"."ref" and typeof(case when json_valid("transaction_steps"."receipt_json") then json_extract("transaction_steps"."receipt_json", '$.plan.modelSelection.provider') end) = 'text' and length(case when json_valid("transaction_steps"."receipt_json") then json_extract("transaction_steps"."receipt_json", '$.plan.modelSelection.provider') end) > 0 and case when json_valid("transaction_steps"."receipt_json") then json_extract("transaction_steps"."receipt_json", '$.plan.modelSelection.provider') end != 't3') order by "transaction_steps"."id" desc limit 1)), 'unknown') = 'claudeAgent' then 'claude' else coalesce(((select case when json_valid("receipt_json") then json_extract("receipt_json", '$.plan.modelSelection.provider') end from "transaction_steps" where ("transaction_steps"."run_ref" = "runs"."ref" and typeof(case when json_valid("transaction_steps"."receipt_json") then json_extract("transaction_steps"."receipt_json", '$.plan.modelSelection.provider') end) = 'text' and length(case when json_valid("transaction_steps"."receipt_json") then json_extract("transaction_steps"."receipt_json", '$.plan.modelSelection.provider') end) > 0 and case when json_valid("transaction_steps"."receipt_json") then json_extract("transaction_steps"."receipt_json", '$.plan.modelSelection.provider') end != 't3') order by "transaction_steps"."id" desc limit 1)), 'unknown') end where "runs"."harness" = 't3';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_settings` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
update "user_settings" set "name" = 'harness' where "user_settings"."name" = 'agent';
--> statement-breakpoint
update "user_settings" set "name" = 'reviewer_harness' where "user_settings"."name" = 'reviewer_agent';