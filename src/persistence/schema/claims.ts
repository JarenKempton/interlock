import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { runs } from "./runs.ts";

export const claims = sqliteTable("claims", {
  ref: text().primaryKey(),
  ticket: text().notNull(),
  human_owner: text().notNull(),
  run_ref: text()
    .notNull()
    .references(() => runs.ref),
  previous_state_json: text().notNull(),
  claimed_at: text().notNull(),
  lease_expires_at: text().notNull(),
  status: text().notNull(),
  current_version: text(),
  supersedes: text(),
  superseded_by: text(),
  claim_home: text(),
  claim_home_url: text(),
  record_version: integer(),
  lock_ref: text(),
  config_commit: text(),
});

export type ClaimRow = typeof claims.$inferSelect;
export type NewClaimRow = typeof claims.$inferInsert;
export const claimRowSchema = createSelectSchema(claims);
export const newClaimRowSchema = createInsertSchema(claims);
