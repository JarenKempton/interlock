import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { configurationStore } from "../persistence/configuration.ts";
import type { UserSettings } from "./schema.ts";
export function readUserSettings(statePath: string): UserSettings {
  if (!existsSync(statePath)) return {};
  const database = new Database(statePath, { readonly: true, strict: true });
  try {
    if (
      !database
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'")
        .get()
    )
      return {};
    return configurationStore(database).readUser();
  } finally {
    database.close();
  }
}
