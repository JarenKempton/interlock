import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const configurationOverrides = sqliteTable("configuration_overrides", {
  project_path: text().primaryKey(),
  settings_json: text().notNull(),
});

export type ConfigurationOverrideRow = typeof configurationOverrides.$inferSelect;
export type NewConfigurationOverrideRow = typeof configurationOverrides.$inferInsert;
export const configurationOverrideRowSchema = createSelectSchema(configurationOverrides);
export const newConfigurationOverrideRowSchema = createInsertSchema(configurationOverrides);
