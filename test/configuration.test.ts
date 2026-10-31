import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describeAction, registeredActions } from "../src/cli/catalog.ts";
import { run } from "../src/cli.ts";
import { configurationActions } from "../src/configuration/commands.ts";
import {
  configurationReference,
  configurationVersion,
  parseProjectToml,
} from "../src/configuration/files.ts";
import { readUserSettings } from "../src/configuration/local-settings.ts";
import {
  configurationOperations,
  INITIAL_CONFIGURATION,
} from "../src/configuration/project-files.ts";
import {
  personalSettingsSchema,
  projectConfigurationSchema,
  REMOVED_SECTIONS,
  type ResolvedConfigurationV1,
  resolveConfiguration,
  SETTING_KEYS,
  type UserSettings,
  validateExecutionConfiguration,
  validateProjectConfiguration,
  validateResolvedConfiguration,
} from "../src/configuration/schema.ts";
import { adapterRefSchema, runRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { Run } from "../src/domain/model.ts";
import { executionTarget } from "../src/execution/pickup-runtime.ts";
import { configurationStore } from "../src/persistence/configuration.ts";
import { StateStore } from "../src/persistence/state.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "wf-config-")));
  directories.push(cwd);
  const path = join(cwd, "interlock.toml");
  const statePath = join(cwd, "local.db");
  const ops = configurationOperations({ cwd, statePath });
  return { cwd, path, statePath, ops };
}
const input = {};

test("Zod schemas own configuration types and setting discovery", () => {
  expect(SETTING_KEYS).toEqual(personalSettingsSchema.keyof().options);
  expect(projectConfigurationSchema.parse(Bun.TOML.parse(INITIAL_CONFIGURATION))).toEqual(
    parseProjectToml(INITIAL_CONFIGURATION),
  );
  const typeExamples = () => {
    const settings = personalSettingsSchema.parse({});
    // @ts-expect-error Unknown setting names must not become part of the inferred API.
    settings.secret;
  };
  void typeExamples;
});

test.each(["unknown-field", "nested-array", "null-section"])(
  "Zod rejects malformed %s without exposing untrusted keys or values",
  (scenario) => {
    const project = z
      .record(z.string(), z.unknown())
      .parse(structuredClone(Bun.TOML.parse(INITIAL_CONFIGURATION)));
    if (scenario === "unknown-field") project.instructions = { DO_NOT_ECHO: "DO_NOT_ECHO" };
    if (scenario === "nested-array")
      project.statuses = { pickable: ["To Do", { DO_NOT_ECHO: true }] };
    if (scenario === "null-section") project.statuses = null;
    let error: unknown;
    try {
      validateProjectConfiguration(project);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Invalid configuration at project");
    expect(String(error)).not.toContain("DO_NOT_ECHO");
    // Wrapping does not retain a raw ZodError containing untrusted issue data.
    expect(z.instanceof(Error).parse(error).cause).toBeUndefined();
  },
);

test.each(Object.keys(REMOVED_SECTIONS))(
  "a shared config that still has [%s] fails and names the replacement",
  (section) => {
    expect(() => parseProjectToml(`version = 1\n[${section}]\n`)).toThrow(
      `interlock.toml [${section}] was removed: ${REMOVED_SECTIONS[section]}`,
    );
  },
);

test("a version 1 file names every removed section it still has, not its version", () => {
  const legacy = `version = 1\n[repositories.app]\ngithub = "o/r"\npath = "."\nworktree_root = "../w"\nbase_branch = "main"\n[maps.APP-1]\nrepository = "app"\nclaim_status = "In Progress"\navailable_statuses = ["To Do"]\n[tracker.jira]\nsite = "https://example.atlassian.net"\n[t3]\nprovider = "codex"\n[defaults]\nhost = "t3"\n`;
  expect(() => parseProjectToml(legacy)).toThrow(
    `interlock.toml [repositories] was removed: ${REMOVED_SECTIONS.repositories}; [maps] was removed: ${REMOVED_SECTIONS.maps}; [t3], [defaults] were removed: ${REMOVED_SECTIONS.t3}`,
  );
});

test("resolved snapshot validation rejects forged settings and provenance after schema validation", () => {
  const snapshot = resolve(INITIAL_CONFIGURATION, { model: "chosen" });
  expect(() =>
    validateResolvedConfiguration({
      ...snapshot,
      sources: { ...snapshot.sources, model: "default" },
    }),
  ).toThrow("resolved.settings");
  expect(() =>
    validateResolvedConfiguration({
      ...snapshot,
      settings: { ...snapshot.settings, pickable_statuses: ["Anything"] },
    }),
  ).toThrow("resolved.settings");
});
function resolve(content: string | undefined, user: UserSettings = {}) {
  return content === undefined
    ? resolveConfiguration(undefined, user)
    : resolveConfiguration(parseProjectToml(content), user, {
        path: "/project/interlock.toml",
        version: configurationVersion(content),
      });
}

test("with no shared config, defaults apply and user settings override them", () => {
  expect(resolve(undefined)).toEqual({
    version: 2,
    settings: {
      host: "t3",
      branch: "task/{key}",
      pickable_statuses: ["To Do"],
      claimed_status: "In Progress",
    },
    sources: {
      host: "default",
      branch: "default",
      pickable_statuses: "default",
      claimed_status: "default",
    },
  });
  const user = resolve(undefined, {
    jira_site: "https://mine.atlassian.net",
    model: "chosen",
    pickable_statuses: "Ready, To Do",
    claimed_status: "Doing",
  });
  expect(user.settings).toMatchObject({
    jira_site: "https://mine.atlassian.net",
    model: "chosen",
    pickable_statuses: ["Ready", "To Do"],
    claimed_status: "Doing",
  });
  expect(user.sources).toMatchObject({ jira_site: "user", model: "user", claimed_status: "user" });
});

test("shared tracker facts override user settings; personal choices stay personal", () => {
  const shared = `version = 2\n[tracker.jira]\nsite = "https://team.atlassian.net"\n[statuses]\npickable = ["Ready"]\nclaimed = "Doing"\n`;
  const resolved = resolve(shared, {
    jira_site: "https://mine.atlassian.net",
    pickable_statuses: "To Do",
    model: "chosen",
  });
  expect(resolved.settings).toMatchObject({
    jira_site: "https://team.atlassian.net",
    pickable_statuses: ["Ready"],
    claimed_status: "Doing",
    model: "chosen",
  });
  expect(resolved.sources).toMatchObject({
    jira_site: "shared",
    pickable_statuses: "shared",
    claimed_status: "shared",
    model: "user",
  });
  expect(resolve(shared).source?.version).not.toBe(resolve(`${shared}\n`).source?.version);
});

test("a branch template must carry {key}", () => {
  expect(() => resolve(undefined, { branch: "task/fixed" })).toThrow("user.branch");
  expect(resolve(undefined, { branch: "me/{key}" }).settings.branch).toBe("me/{key}");
});

test("init creates a validated shape and never replaces a file or dangling symlink", async () => {
  const f = fixture();
  const result = await f.ops.init(input);
  expect(result.configuration.settings).toMatchObject({ host: "t3", branch: "task/{key}" });
  expect(result.configuration.source?.path).toBe(f.path);
  expect(existsSync(f.statePath)).toBe(false);
  await expect(f.ops.init(input)).rejects.toThrow();
  expect(readFileSync(f.path, "utf8")).toBe(INITIAL_CONFIGURATION);
  if (process.platform === "win32") return; // Windows symlink creation requires a separate OS privilege.
  const link = join(f.cwd, "link.toml");
  symlinkSync(join(f.cwd, "absent"), link);
  await expect(f.ops.init({ ...input, path: link })).rejects.toThrow();
});

test("init imports project shape explicitly and refuses invalid input before creating files", async () => {
  const f = fixture();
  const source = join(f.cwd, "source.toml");
  writeFileSync(source, "malformed = [");
  await expect(f.ops.init({ ...input, from: source })).rejects.toThrow("Malformed project TOML");
  expect(existsSync(f.path)).toBe(false);
  writeFileSync(source, INITIAL_CONFIGURATION);
  expect((await f.ops.init({ ...input, from: source })).action).toBe("initialized");
});

test("show and set work without interlock.toml; choices survive reopen and follow removes them", async () => {
  const f = fixture();
  expect((await f.ops.show(input)).configuration.source).toBeUndefined();
  expect(readdirSync(f.cwd)).toEqual([]);
  await f.ops.edit({ ...input, set: ["model", "chosen"] });
  expect(readUserSettings(f.statePath)).toEqual({ model: "chosen" });
  await f.ops.init(input);
  const reopened = configurationOperations({ cwd: f.cwd, statePath: f.statePath });
  expect((await reopened.show(input)).configuration.settings.model).toBe("chosen");
  expect(
    (await reopened.edit({ ...input, follow: "model" })).configuration.settings.model,
  ).toBeUndefined();
  expect(readUserSettings(f.statePath)).toEqual({});
});

test("an explicitly named shared config must exist", async () => {
  const f = fixture();
  await expect(f.ops.show({ path: "absent.toml" })).rejects.toThrow();
  await expect(f.ops.edit({ path: "absent.toml", set: ["model", "chosen"] })).rejects.toThrow();
  expect(existsSync(f.statePath)).toBe(false);
});

test("claim-home is one user-level setting, stored normalized", async () => {
  const f = fixture();
  await f.ops.edit({ ...input, set: ["claim-home", "Team/Locks"] });
  expect(readUserSettings(f.statePath)).toEqual({
    claim_home: "https://github.com/Team/Locks.git",
  });
  const leaked = await f.ops
    .edit({ ...input, set: ["claim-home", "https://secret@github.com/a/b.git"] })
    .catch((error: Error) => error.message);
  expect(leaked).toContain("without credentials");
  expect(leaked).not.toContain("secret");
  expect(readUserSettings(f.statePath).claim_home).toBe("https://github.com/Team/Locks.git");
});

test("an invalid choice leaves earlier choices intact", async () => {
  const f = fixture();
  await f.ops.edit({ ...input, set: ["pickable_statuses", "Ready"] });
  await expect(f.ops.edit({ ...input, set: ["branch", "no-key"] })).rejects.toThrow("user.branch");
  await expect(f.ops.edit({ ...input, set: ["jira_site", "http://insecure"] })).rejects.toThrow(
    "user.jira_site",
  );
  expect(readUserSettings(f.statePath)).toEqual({ pickable_statuses: "Ready" });
});

test("execution snapshots persist independently and cannot be silently replaced", () => {
  const f = fixture();
  let store = new StateStore(f.statePath);
  const run: Run = {
    ref: runRefSchema.parse("interlock-run:config"),
    ticket: ticketRefSchema.parse("jira:example:P:ticket:P-1"),
    harness: adapterRefSchema.parse("codex"),
    workspace: { path: "/workspace" },
    capabilities: {},
    status: "planning",
    createdAt: "now",
    updatedAt: "now",
  };
  store.saveRun(run);
  const original = {
    ...resolve(INITIAL_CONFIGURATION, { model: "original" }),
    repository: {
      name: "app",
      remote: "https://github.com/o/app.git",
      path: "/repo/app",
      worktreeRoot: "/repo/worktrees/app",
      baseBranch: "main",
    },
  };
  store.saveExecutionConfiguration(run.ref, original);
  store.close();
  store = new StateStore(f.statePath);
  try {
    expect(store.getExecutionConfiguration(run.ref)).toEqual(original);
    expect(() =>
      store.saveExecutionConfiguration(run.ref, resolve(INITIAL_CONFIGURATION, { model: "new" })),
    ).toThrow();
    expect(store.getExecutionConfiguration(run.ref)).toEqual(original);
  } finally {
    store.close();
  }
});

test.each(["version = 3", 'token = "DO_NOT_ECHO"', 'version = "DO_NOT_ECHO"'])(
  "malformed project values are rejected without echoing them: %s",
  (prefix) => {
    const content = prefix.includes("version")
      ? INITIAL_CONFIGURATION.replace("version = 2", prefix)
      : `${prefix}\n${INITIAL_CONFIGURATION}`;
    try {
      parseProjectToml(content);
      throw new Error("accepted invalid input");
    } catch (error) {
      expect(String(error)).toContain("Invalid configuration");
      expect(String(error)).not.toContain("DO_NOT_ECHO");
    }
  },
);

test("rejects credentials in the tracker URL and an empty status list", () => {
  expect(() =>
    parseProjectToml('[tracker.jira]\nsite = "https://user:secret@example.atlassian.net"\n'),
  ).toThrow("tracker.jira.site");
  expect(() => parseProjectToml("[statuses]\npickable = []\n")).toThrow(
    "project.statuses.pickable",
  );
  expect(() => resolve(undefined, { pickable_statuses: " , " })).toThrow("user.pickable_statuses");
});

test("configuration references resolve against the project file without shell expansion", () => {
  const f = fixture();
  expect(configurationReference(f.path, "docs/contract.md")).toBe(
    join(f.cwd, "docs", "contract.md"),
  );
  expect(() => configurationReference("/project/interlock.toml", "~/contract.md")).toThrow(
    "shell expansion",
  );
});

test.each(["failure", "malformed", "concurrent"])(
  "staged editor %s preserves the project file",
  async (scenario) => {
    const f = fixture();
    await f.ops.init(input);
    let stagedPath = "";
    const operations = configurationOperations({
      cwd: f.cwd,
      statePath: f.statePath,
      editFile: async (argv) => {
        stagedPath = z.string().parse(argv[1]);
        expect(argv[0]).toBe("editor with spaces");
        writeFileSync(
          z.string().parse(argv[1]),
          scenario === "malformed" ? "broken = [" : `${INITIAL_CONFIGURATION}\n# edit`,
        );
        if (scenario === "concurrent")
          writeFileSync(f.path, `${INITIAL_CONFIGURATION}\n# external edit`);
        return scenario === "failure" ? 1 : 0;
      },
    });
    await expect(operations.edit({ ...input, editor: "editor with spaces" })).rejects.toThrow(
      "Edited draft retained at",
    );
    expect(readFileSync(stagedPath, "utf8")).toBe(
      scenario === "malformed" ? "broken = [" : `${INITIAL_CONFIGURATION}\n# edit`,
    );
    expect(readFileSync(f.path, "utf8")).toBe(
      INITIAL_CONFIGURATION + (scenario === "concurrent" ? "\n# external edit" : ""),
    );
  },
);

test("successful editor commits validated staged content and reports its identity", async () => {
  const f = fixture();
  await f.ops.init(input);
  const content = `${INITIAL_CONFIGURATION}\n# intentional edit`;
  const ops = configurationOperations({
    cwd: f.cwd,
    statePath: f.statePath,
    editFile: async (argv) => {
      writeFileSync(z.string().parse(argv[1]), content);
      return 0;
    },
  });
  const output = await ops.edit({ ...input, editor: "fake" });
  expect(readFileSync(f.path, "utf8")).toBe(content);
  expect(output.configuration.source?.version).toBe(configurationVersion(content));
});

test("configuration catalog drives help, JSON help, registration and man page", async () => {
  const f = fixture();
  const services = { configuration: { cwd: f.cwd, statePath: f.statePath } };
  const actions = registeredActions(configurationActions(services.configuration));
  for (const entry of actions) {
    const action = describeAction(entry);
    const human: string[] = [];
    const json: string[] = [];
    await run([...action.command, "--help"], (text) => human.push(text), services);
    await run([...action.command, "--help", "--json"], (text) => json.push(text), services);
    expect(human.join("")).toContain(action.description);
    expect(JSON.parse(z.string().parse(json[0]))).toMatchObject({
      description: action.description,
      input: action.input,
    });
  }
  const manual: string[] = [];
  await run(["man"], (text) => manual.push(text), services);
  expect(manual[0]).toContain(actions[1]?.action.description);
  const output: string[] = [];
  await run(["init", "--json"], (text) => output.push(text), services);
  expect(JSON.parse(z.string().parse(output[0])).action).toBe("initialized");
  const show: string[] = [];
  await run(["config", "show", "--json"], (text) => show.push(text), services);
  expect(JSON.parse(z.string().parse(show[0])).configuration).toEqual(
    JSON.parse(z.string().parse(output[0])).configuration,
  );
});

test.each(
  [
    ["init", "--path"],
    ["init", "--json", "--json"],
    ["config", "show", "--unknown"],
    ["config", "edit", "--set", "secret", "DO_NOT_ECHO"],
    ["config", "edit", "--set", "model"],
    ["config", "edit", "--follow", "model", "--editor", "vi"],
  ].map((args) => ({ args })),
)("CLI rejects malformed configuration arguments without mutations: %j", async ({ args }) => {
  const f = fixture();
  await expect(
    run(args, () => {}, { configuration: { cwd: f.cwd, statePath: f.statePath } }),
  ).rejects.toThrow();
  expect(readdirSync(f.cwd)).toEqual([]);
});

test("show reads an existing local database without changing durable data", async () => {
  const f = fixture();
  await f.ops.init(input);
  await f.ops.edit({ ...input, set: ["model", "chosen"] });
  const before = readFileSync(f.statePath);
  await f.ops.show(input);
  expect(readFileSync(f.statePath).equals(before)).toBe(true);
  expect(readUserSettings(f.statePath)).toEqual({ model: "chosen" });
});

test("invalid user setting fails before creating local state", async () => {
  const f = fixture();
  await expect(f.ops.edit({ ...input, set: ["runtime_mode", "invalid"] })).rejects.toThrow(
    "user.runtime_mode",
  );
  expect(existsSync(f.statePath)).toBe(false);
});

test("config group JSON help lists the same registered action contracts", async () => {
  const output: string[] = [];
  await run(["config", "--help", "--json"], (text) => output.push(text));
  expect(
    JSON.parse(z.string().parse(output[0])).actions.map(
      (action: { command: string[] }) => action.command,
    ),
  ).toEqual(
    registeredActions(configurationActions({ cwd: "/unused" }))
      .filter((entry) => entry.command[0] === "config")
      .map((entry) => entry.command),
  );
  await expect(run(["config", "--help", "--unknown"], () => {})).rejects.toThrow("Group help");
});

test("Drizzle reads the existing schema, respects read-only handles and redacts driver parameters", () => {
  const f = fixture();
  const database = new Database(f.statePath, { create: true });
  database.exec("CREATE TABLE user_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  database.query("INSERT INTO user_settings VALUES (?, ?)").run("model", "existing-choice");
  database.close();
  const before = readFileSync(f.statePath);
  const readonly = new Database(f.statePath, { readonly: true });
  try {
    const settings = configurationStore(readonly);
    expect(settings.readUser()).toEqual({ model: "existing-choice" });
    try {
      settings.saveUser("model", "DO_NOT_ECHO");
      throw new Error("Expected read-only rejection");
    } catch (error) {
      expect(String(error)).toContain("Local configuration database operation failed");
      expect(String(error)).not.toContain("DO_NOT_ECHO");
      expect(String(error)).not.toContain("INSERT");
    }
  } finally {
    readonly.close();
  }
  expect(readFileSync(f.statePath).equals(before)).toBe(true);
});

test("persisted user settings are validated before they can become choices", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE user_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const name of ["runtime_mode", "token"]) {
      db.exec("DELETE FROM user_settings");
      db.query("INSERT INTO user_settings VALUES (?, ?)").run(name, "DO_NOT_ECHO");
      try {
        configurationStore(db).readUser();
        throw new Error("Expected malformed record rejection");
      } catch (error) {
        expect(String(error)).toContain("Invalid");
        expect(String(error)).not.toContain("DO_NOT_ECHO");
      }
    }
  } finally {
    db.close();
  }
});

test.each(["success", "constraint failure"])(
  "configuration statements are finalized after %s without waiting for garbage collection",
  (scenario) => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE user_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec(
        "CREATE TABLE execution_configurations (run_ref TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL)",
      );
      const store = configurationStore(db);
      store.saveUser("model", "chosen");
      expect(store.readUser()).toEqual({ model: "chosen" });
      store.saveUser("model", undefined);
      expect(store.readUser()).toEqual({});
      const snapshot = resolve(INITIAL_CONFIGURATION);
      store.saveSnapshot("run", snapshot);
      expect(store.readSnapshot("run")).toEqual(snapshot);
      if (scenario === "constraint failure")
        expect(() => store.saveSnapshot("run", snapshot)).toThrow();
      // Bun 1.3 strict close exposes unfinalized statements on every platform.
      // Windows additionally keeps the database file locked after a deferred close.
      expect(() => db.close(true)).not.toThrow();
    } finally {
      db.close();
    }
  },
);

test("follow all clears every personal choice but keeps sign-in and claim home", async () => {
  const f = fixture();
  await f.ops.edit({ set: ["jira_site", "https://mine.atlassian.net"] });
  await f.ops.edit({ set: ["claim-home", "team/locks"] });
  await f.ops.edit({ set: ["agent", "claude"] });
  await f.ops.edit({ set: ["pickable_statuses", "Ready"] });
  const output: string[] = [];
  await run(["config", "edit", "--follow", "all", "--json"], (line) => output.push(line), {
    configuration: { cwd: f.cwd, statePath: f.statePath },
  });
  const result = JSON.parse(output[0] ?? "");
  expect(result.configuration.settings.agent).toBeUndefined();
  expect(result.configuration.settings.pickable_statuses).toEqual(["To Do"]);
  expect(readUserSettings(f.statePath)).toEqual({
    jira_site: "https://mine.atlassian.net",
    claim_home: "https://github.com/team/locks.git",
  });
});

test("symlink aliases share project identity without permitting overwrite", async () => {
  if (process.platform === "win32") return; // Windows symlink creation requires a separate OS privilege.
  const f = fixture();
  await f.ops.init({});
  const alias = join(f.cwd, "alias.toml");
  symlinkSync(f.path, alias);
  expect((await f.ops.show({ path: alias })).configuration).toEqual(
    (await f.ops.show({})).configuration,
  );
  await expect(f.ops.init({ path: alias })).rejects.toThrow();
  expect(readFileSync(f.path, "utf8")).toBe(INITIAL_CONFIGURATION);
  await expect(f.ops.edit({ path: alias, editor: "unused" })).rejects.toThrow("not a symlink");
});

test("version 1 receipts retain their historical resolution contract", () => {
  // Fixed historical data, deliberately not generated by today's resolver or starter.
  const receipt = {
    version: 1,
    source: { path: "/historical/interlock.toml", version: "sha256:historical-content" },
    project: {
      version: 1,
      repositories: {},
      maps: {},
      tracker: { jira: { site: "https://example.atlassian.net" } },
      t3: { provider: "codex", model: "historical-default", thinking_effort: "high" },
      defaults: { model: "project-default" },
      required: { runtime_mode: "approval-required" },
    },
    settings: {
      host: "t3",
      agent: "codex",
      model: "personal-choice",
      effort: "high",
      runtime_mode: "approval-required",
    },
    sources: {
      host: "default",
      agent: "default",
      model: "personal",
      effort: "default",
      runtime_mode: "required",
    },
  } satisfies ResolvedConfigurationV1;
  expect(validateExecutionConfiguration(receipt)).toEqual(receipt);
  expect(() => validateExecutionConfiguration({ ...receipt, version: 99 })).toThrow(
    "Invalid configuration",
  );
  const withRepository = {
    ...receipt,
    project: {
      ...receipt.project,
      repositories: {
        app: { github: "o/app", path: "app", worktree_root: "worktrees", base_branch: "main" },
      },
    },
  };
  expect(executionTarget(validateExecutionConfiguration(withRepository), "app")).toEqual({
    repository: {
      name: "app",
      path: "/historical/app",
      worktreeRoot: "/historical/worktrees",
      baseBranch: "main",
      remote: "https://github.com/o/app.git",
    },
    jiraSite: "https://example.atlassian.net",
    claimedStatus: "In Progress",
  });
});
