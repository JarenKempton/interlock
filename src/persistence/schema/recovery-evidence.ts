import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { runs } from "./runs.ts";

export const recoveryEvidence = sqliteTable("recovery_evidence", {
  id: integer().primaryKey({ autoIncrement: true }),
  run_ref: text()
    .notNull()
    .references(() => runs.ref),
  outcome: text().notNull(),
  evidence_json: text().notNull(),
  occurred_at: text().notNull(),
});

export type RecoveryEvidenceRow = typeof recoveryEvidence.$inferSelect;
export type NewRecoveryEvidenceRow = typeof recoveryEvidence.$inferInsert;
export const recoveryEvidenceRowSchema = createSelectSchema(recoveryEvidence);
export const newRecoveryEvidenceRowSchema = createInsertSchema(recoveryEvidence);
