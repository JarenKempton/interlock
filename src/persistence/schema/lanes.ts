import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const lanes = sqliteTable("lanes", {
  id: text().primaryKey(),
  ticket: text(),
  title: text(),
  run_ref: text(),
  claim_ref: text(),
  state: text().notNull(),
  previous_state: text(),
  attention_reason: text(),
  artifact: text(),
  head: text(),
  evidence_json: text().notNull(),
  verdict_json: text(),
  review_round: integer().notNull(),
  max_review_rounds: integer().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

export type LaneRow = typeof lanes.$inferSelect;
export type NewLaneRow = typeof lanes.$inferInsert;
export const laneRowSchema = createSelectSchema(lanes);
export const newLaneRowSchema = createInsertSchema(lanes);
