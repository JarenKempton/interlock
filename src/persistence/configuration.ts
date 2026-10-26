import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import {
  type UserSettingKey,
  validatePersonalSettings,
  validateResolvedConfiguration,
  validateUserSettings,
} from "../configuration/schema.ts";
import { ledgerDb } from "./ledger-db.ts";
import {
  configurationOverrideRowSchema,
  configurationOverrides,
} from "./schema/configuration-overrides.ts";
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

const settingsRow = configurationOverrideRowSchema.transform((row) =>
  validatePersonalSettings(decode(row.settings_json)),
);
const snapshotRow = executionConfigurationRowSchema.transform((row) =>
  validateResolvedConfiguration(decode(row.snapshot_json)),
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
    readPersonal(projectPath: string) {
      const row = guarded(() =>
        db
          .select()
          .from(configurationOverrides)
          .where(eq(configurationOverrides.project_path, projectPath))
          .get(),
      );
      return row ? settingsRow.parse(row) : {};
    },
    savePersonal(projectPath: string, input: unknown) {
      const settings = validatePersonalSettings(input);
      if (!Object.keys(settings).length) {
        guarded(() =>
          db
            .delete(configurationOverrides)
            .where(eq(configurationOverrides.project_path, projectPath))
            .run(),
        );
      } else {
        const values = { project_path: projectPath, settings_json: JSON.stringify(settings) };
        guarded(() =>
          db
            .insert(configurationOverrides)
            .values(values)
            .onConflictDoUpdate({
              target: configurationOverrides.project_path,
              set: { settings_json: values.settings_json },
            })
            .run(),
        );
      }
      return settings;
    },
    saveSnapshot(run: string, input: unknown) {
      const snapshot = validateResolvedConfiguration(input);
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
