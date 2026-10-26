import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const runs = sqliteTable("runs", {
  ref: text().primaryKey(),
  ticket: text().notNull(),
  harness: text().notNull(),
  model: text(),
  effort: text(),
  context: text(),
  workspace_json: text().notNull(),
  capabilities_json: text().notNull(),
  status: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
  execution_json: text(),
});

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export const runRowSchema = createSelectSchema(runs);
export const newRunRowSchema = createInsertSchema(runs);
