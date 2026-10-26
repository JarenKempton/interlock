import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { runs } from "./runs.ts";

export const transactionSteps = sqliteTable("transaction_steps", {
  id: integer().primaryKey({ autoIncrement: true }),
  run_ref: text()
    .notNull()
    .references(() => runs.ref),
  state: text().notNull(),
  receipt_json: text(),
  error_text: text(),
  occurred_at: text().notNull(),
});

export type TransactionStepRow = typeof transactionSteps.$inferSelect;
export type NewTransactionStepRow = typeof transactionSteps.$inferInsert;
export const transactionStepRowSchema = createSelectSchema(transactionSteps);
export const newTransactionStepRowSchema = createInsertSchema(transactionSteps);
