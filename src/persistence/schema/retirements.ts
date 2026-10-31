import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const retirements = sqliteTable("retirements", {
  lane: text().primaryKey(),
  run: text().notNull().unique(),
  path: text().notNull(),
  repository: text().notNull(),
  branch: text().notNull(),
  plan_json: text().notNull(),
  phase: text().notNull(),
});
