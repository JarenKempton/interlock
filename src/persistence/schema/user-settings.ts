import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const userSettings = sqliteTable("user_settings", {
  name: text().primaryKey(),
  value: text().notNull(),
});

export type UserSettingRow = typeof userSettings.$inferSelect;
export type NewUserSettingRow = typeof userSettings.$inferInsert;
export const userSettingRowSchema = createSelectSchema(userSettings);
export const newUserSettingRowSchema = createInsertSchema(userSettings);
