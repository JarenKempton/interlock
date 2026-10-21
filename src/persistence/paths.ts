import { join } from "node:path";

export function dataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const root = environment.LOCALAPPDATA;
    if (!root) throw new Error("LOCALAPPDATA is not set");
    return join(root, "Interlock");
  }
  if (process.platform === "darwin") {
    const home = environment.HOME;
    if (!home) throw new Error("HOME is not set");
    return join(home, "Library", "Application Support", "interlock");
  }
  const root = environment.XDG_STATE_HOME;
  if (root) return join(root, "interlock");
  const home = environment.HOME;
  if (!home) throw new Error("HOME is not set");
  return join(home, ".local", "state", "interlock");
}

export function databasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(environment), "interlock.db");
}

export function updateCheckPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(environment), "update-check.json");
}
