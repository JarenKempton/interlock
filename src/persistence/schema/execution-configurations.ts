import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { runs } from "./runs.ts";

export const executionConfigurations = sqliteTable("execution_configurations", {
  run_ref: text()
    .primaryKey()
    .references(() => runs.ref),
  snapshot_json: text().notNull(),
});

export type ExecutionConfigurationRow = typeof executionConfigurations.$inferSelect;
export type NewExecutionConfigurationRow = typeof executionConfigurations.$inferInsert;
export const executionConfigurationRowSchema = createSelectSchema(executionConfigurations);
export const newExecutionConfigurationRowSchema = createInsertSchema(executionConfigurations);
