import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import {
  type UserSettingKey,
  validateExecutionConfiguration,
  validateUserSettings,
} from "../configuration/schema.ts";
import { ledgerDb } from "./ledger-db.ts";
import {
  executionConfigurationRowSchema,
  executionConfigurations,
} from "./schema/execution-configurations.ts";
import { userSettingRowSchema, userSettings } from "./schema/user-settings.ts";

function decode(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid local configuration record");
  }
}

const snapshotRow = executionConfigurationRowSchema.transform((row) =>
  validateExecutionConfiguration(decode(row.snapshot_json)),
);

function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new Error("Local configuration database operation failed");
  }
}

export function configurationStore(database: Database) {
  const db = ledgerDb(database);
  return {
    saveSnapshot(run: string, input: unknown) {
      const snapshot = validateExecutionConfiguration(input);
      guarded(() =>
        db
          .insert(executionConfigurations)
          .values({ run_ref: run, snapshot_json: JSON.stringify(snapshot) })
          .run(),
      );
    },
    readUser() {
      const rows = guarded(() => db.select().from(userSettings).all());
      return validateUserSettings(
        Object.fromEntries(rows.map((row) => [userSettingRowSchema.parse(row).name, row.value])),
      );
    },
    saveUser(name: UserSettingKey, value: string | undefined) {
      if (value === undefined) {
        guarded(() => db.delete(userSettings).where(eq(userSettings.name, name)).run());
        return;
      }
      validateUserSettings({ [name]: value });
      guarded(() =>
        db
          .insert(userSettings)
          .values({ name, value })
          .onConflictDoUpdate({ target: userSettings.name, set: { value } })
          .run(),
      );
    },
    readSnapshot(run: string) {
      const row = guarded(() =>
        db
          .select()
          .from(executionConfigurations)
          .where(eq(executionConfigurations.run_ref, run))
          .get(),
      );
      return row ? snapshotRow.parse(row) : undefined;
    },
  };
}
