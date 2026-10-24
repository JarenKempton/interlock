import { describe, expect, test } from "bun:test";
import { createApplication } from "../src/application.ts";
import {
  completionCandidates,
  completionScript,
  parseCompletionShell,
} from "../src/cli/completions.ts";
import { manPage } from "../src/cli/manpage.ts";

describe("distribution documentation", () => {
  test.each(["bash", "zsh", "fish"] as const)("emits %s completion", (shell) => {
    const script = completionScript(shell);
    expect(script).toContain("interlock");
    expect(script).toContain("--complete");
    expect(script).toContain(shell);
    expect(completionCandidates(createApplication(), [])).toContain("pickup");
    expect(script.endsWith("\n")).toBe(true);
  });

  test("rejects unknown completion shells", () => {
    expect(() => parseCompletionShell("powershell")).toThrow("bash, zsh, fish");
  });

  test("emits a versioned man page", () => {
    const page = manPage("1.2.3-rc.1", createApplication());
    expect(page).toContain('.TH "INTERLOCK" 1');
    expect(page).toContain("interlock 1.2.3-rc.1");
    expect(page).toContain("Print shell completion for the registered actions.");
  });
});

test("generated manual retains operational contracts alongside available commands", () => {
  const page = manPage("test", createApplication());
  for (const heading of ["ENVIRONMENT", "FILES", "EXIT STATUS", "SEE ALSO"])
    expect(page).toContain(heading);
  for (const variable of [
    "INTERLOCK_NO_UPDATE_CHECK",
    "INTERLOCK_UPDATE_URL",
    "XDG_STATE_HOME",
    "LOCALAPPDATA",
    "VISUAL",
    "EDITOR",
  ])
    expect(page).toContain(variable);
  expect(page).toContain("Secrets must not be placed");
  expect(page).toContain("command arguments, logs, or receipts");
  expect(page).toContain("interlock.db");
  expect(page).toContain("config show");
  expect(page).not.toContain("Stop a recorded run");
});
