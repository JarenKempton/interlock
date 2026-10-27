import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.INTERLOCK_TEST_REAL_PATHS !== "1") {
  const root = mkdtempSync(join(tmpdir(), "interlock-test-home-"));
  const paths = {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    LOCALAPPDATA: join(root, "local-app-data"),
    APPDATA: join(root, "app-data"),
  };
  for (const [name, path] of Object.entries(paths)) {
    mkdirSync(path, { recursive: true });
    process.env[name] = path;
  }
  process.env.INTERLOCK_TEST_HOME = root;
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
}
