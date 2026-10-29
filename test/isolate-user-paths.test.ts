import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { databasePath, dataDirectory } from "../src/persistence/paths.ts";

test("tests never resolve the real user ledger or settings", () => {
  const root = process.env.INTERLOCK_TEST_HOME;
  if (!root) throw new Error("Test preload did not isolate user paths");
  expect(root.startsWith(tmpdir())).toBe(true);
  for (const name of [
    "HOME",
    "USERPROFILE",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "LOCALAPPDATA",
    "APPDATA",
  ])
    expect(process.env[name]?.startsWith(root)).toBe(true);
  expect(dataDirectory().startsWith(root)).toBe(true);
  expect(databasePath().startsWith(root)).toBe(true);
});

test("dev and release builds resolve different state directories", () => {
  const environment = {
    HOME: "/home/user",
    XDG_STATE_HOME: "/home/user/.local/state",
    LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
  };
  const release = dataDirectory(environment, true);
  const dev = dataDirectory(environment, false);
  expect(release).not.toBe(dev);
  expect(release.toLowerCase().endsWith("interlock")).toBe(true);
  expect(dev.toLowerCase().endsWith("interlock-dev")).toBe(true);
  expect(dataDirectory()).toBe(dataDirectory(process.env, false));
});
