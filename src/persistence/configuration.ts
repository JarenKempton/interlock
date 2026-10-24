import type { Database } from "bun:sqlite";
import { eq, type Query } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
  type UserSettingKey,
  validatePersonalSettings,
  validateResolvedConfiguration,
  validateUserSettings,
} from "../configuration/schema.ts";

export const configurationOverrides = sqliteTable("configuration_overrides", {
  project_path: text().primaryKey(),
  settings_json: text().notNull(),
});
export const executionConfigurations = sqliteTable("execution_configurations", {
  run_ref: text().primaryKey(),
  snapshot_json: text().notNull(),
});
export const userSettings = sqliteTable("user_settings", {
  name: text().primaryKey(),
  value: text().notNull(),
});
const userSettingRow = createSelectSchema(userSettings);
function decode(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid local configuration record");
  }
}
const settingsRow = createSelectSchema(configurationOverrides).transform((row) =>
  validatePersonalSettings(decode(row.settings_json)),
);
const snapshotRow = createSelectSchema(executionConfigurations).transform((row) =>
  validateResolvedConfiguration(decode(row.snapshot_json)),
);

/** Wrap the caller's connection, preserving its read-only and transaction settings. */
export function configurationStore(database: Database) {
  const db = drizzle(database);
  return {
    readPersonal(projectPath: string) {
      const row = databaseOperation(
        database,
        "get",
        db
          .select()
          .from(configurationOverrides)
          .where(eq(configurationOverrides.project_path, projectPath))
          .toSQL(),
      );
      return row ? settingsRow.parse(row) : {};
    },
    savePersonal(projectPath: string, input: unknown) {
      const settings = validatePersonalSettings(input);
      if (!Object.keys(settings).length) {
        databaseOperation(
          database,
          "run",
          db
            .delete(configurationOverrides)
            .where(eq(configurationOverrides.project_path, projectPath))
            .toSQL(),
        );
      } else {
        const values = { project_path: projectPath, settings_json: JSON.stringify(settings) };
        databaseOperation(
          database,
          "run",
          db
            .insert(configurationOverrides)
            .values(values)
            .onConflictDoUpdate({
              target: configurationOverrides.project_path,
              set: { settings_json: values.settings_json },
            })
            .toSQL(),
        );
      }
      return settings;
    },
    readUser() {
      const rows = z
        .array(userSettingRow)
        .parse(databaseOperation(database, "all", db.select().from(userSettings).toSQL()));
      return validateUserSettings(Object.fromEntries(rows.map((row) => [row.name, row.value])));
    },
    saveUser(name: UserSettingKey, value: string | undefined) {
      if (value === undefined) {
        databaseOperation(
          database,
          "run",
          db.delete(userSettings).where(eq(userSettings.name, name)).toSQL(),
        );
        return;
      }
      validateUserSettings({ [name]: value });
      databaseOperation(
        database,
        "run",
        db
          .insert(userSettings)
          .values({ name, value })
          .onConflictDoUpdate({ target: userSettings.name, set: { value } })
          .toSQL(),
      );
    },
    saveSnapshot(run: string, input: unknown) {
      const snapshot = validateResolvedConfiguration(input);
      databaseOperation(
        database,
        "run",
        db
          .insert(executionConfigurations)
          .values({ run_ref: run, snapshot_json: JSON.stringify(snapshot) })
          .toSQL(),
      );
    },
    readSnapshot(run: string) {
      const row = databaseOperation(
        database,
        "get",
        db
          .select()
          .from(executionConfigurations)
          .where(eq(executionConfigurations.run_ref, run))
          .toSQL(),
      );
      return row ? snapshotRow.parse(row) : undefined;
    },
  };
}

// Drizzle 0.45's Bun driver leaves one-shot prepared statements to GC. On Bun
// 1.3 that keeps Windows database files locked after close. Generate SQL with
// Drizzle, execute on the caller's connection, and always finalize explicitly.
function databaseOperation(
  database: Database,
  method: "all" | "get" | "run",
  query: Query,
): unknown {
  try {
    // These configuration tables bind only text; row JSON is validated separately.
    const params = z.array(z.string()).parse(query.params);
    const statement = database.prepare<unknown, string[]>(query.sql);
    try {
      return statement[method](...params);
    } finally {
      statement.finalize();
    }
  } catch {
    // Driver errors can include SQL and bound values.
    throw new Error("Local configuration database operation failed");
  }
}
