import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { savedT3Choices, savedT3Configuration } from "../adapters/hosts/t3/legacy.ts";
import type { RunRef } from "../domain/model.ts";
import type { StateStore } from "../persistence/state.ts";
import {
  type ExecutionConfiguration,
  type UserSettingKey,
  type UserSettings,
  userSettingsSchema,
  validateExecutionConfiguration,
  validateUserSettings,
} from "./schema.ts";
import { ledgerDb } from "../persistence/ledger-db.ts";
import {
  executionConfigurationRowSchema,
  executionConfigurations,
} from "../persistence/schema/execution-configurations.ts";
import { userSettingRowSchema, userSettings } from "../persistence/schema/user-settings.ts";

function decode(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid local configuration record");
  }
}

const snapshotRow = executionConfigurationRowSchema.transform((row) =>
  validateExecutionConfiguration(savedT3Configuration(decode(row.snapshot_json))),
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
        savedT3Choices(
          Object.fromEntries(rows.map((row) => [userSettingRowSchema.parse(row).name, row.value])),
        ),
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

export function updateUserSettings(
  store: StateStore,
  update: (settings: UserSettings) => UserSettings,
): UserSettings {
  const config = configurationStore(store.database);
  return store.database
    .transaction(() => {
      const current = config.readUser();
      const next = update({ ...current });
      for (const key of userSettingsSchema.keyof().options)
        if (current[key] !== next[key]) config.saveUser(key, next[key]);
      return config.readUser();
    })
    .immediate();
}

export function storedUserSettings(store: StateStore): UserSettings {
  return configurationStore(store.database).readUser();
}

export function saveUserSetting(
  store: StateStore,
  name: UserSettingKey,
  value: string | undefined,
): void {
  configurationStore(store.database).saveUser(name, value);
}

export function saveClaimHomeIfAbsent(store: StateStore, home: string): boolean {
  return store.database
    .transaction(() => {
      if (storedUserSettings(store).claim_home !== undefined) return false;
      saveUserSetting(store, "claim_home", home);
      return true;
    })
    .immediate();
}

export function saveExecutionConfiguration(
  store: StateStore,
  run: RunRef,
  configuration: ExecutionConfiguration,
): void {
  configurationStore(store.database).saveSnapshot(run, configuration);
}

export function getExecutionConfiguration(
  store: StateStore,
  run: RunRef,
): ExecutionConfiguration | undefined {
  return configurationStore(store.database).readSnapshot(run);
}
