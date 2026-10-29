import { join } from "node:path";
import { RELEASE_BUILD } from "../distribution/version.ts";

export function dataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  release = RELEASE_BUILD,
): string {
  const name = release ? "interlock" : "interlock-dev";
  if (process.platform === "win32") {
    const root = environment.LOCALAPPDATA;
    if (!root) throw new Error("LOCALAPPDATA is not set");
    return join(root, release ? "Interlock" : "Interlock-dev");
  }
  if (process.platform === "darwin") {
    const home = environment.HOME;
    if (!home) throw new Error("HOME is not set");
    return join(home, "Library", "Application Support", name);
  }
  const root = environment.XDG_STATE_HOME;
  if (root) return join(root, name);
  const home = environment.HOME;
  if (!home) throw new Error("HOME is not set");
  return join(home, ".local", "state", name);
}

export function databasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(environment), "interlock.db");
}

export function updateCheckPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(environment), "update-check.json");
}
