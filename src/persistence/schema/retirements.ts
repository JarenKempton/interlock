import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const retirements = sqliteTable(
  "retirements",
  {
    lane: text().primaryKey(),
    run: text().notNull().unique(),
    path: text().notNull().unique(),
    repository: text().notNull(),
    branch: text().notNull(),
    plan_json: text().notNull(),
    phase: text().notNull(),
  },
  (table) => [uniqueIndex("retirements_repository_branch").on(table.repository, table.branch)],
);
