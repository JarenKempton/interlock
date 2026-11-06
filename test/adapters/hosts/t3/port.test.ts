import { describe, expect, test } from "bun:test";
import {
  hostT3Cli,
  type T3CommandResult,
  type T3Process,
} from "../../../../src/adapters/hosts/t3/cli.ts";
import { type T3LaunchPlan, T3HostPort } from "../../../../src/adapters/hosts/t3/port.ts";
import { laneRefSchema, ticketRefSchema } from "../../../../src/domain/identifiers.ts";
import { rejection } from "../../../fixtures/rejection.ts";

const lane = laneRefSchema.parse("interlock-lane:one");
const ticket = ticketRefSchema.parse("jira:acme:W:ticket:W-1");
const base = "a".repeat(40);
const plan: T3LaunchPlan = {
  project: "/repo",
  lane,
  ticket,
  key: "W-1",
  title: "W-1: Ship it",
  message: "Lane procedure",
  baseCommit: base,
  branch: "task/W-1",
};
const descriptor = {
  environmentId: "env-1",
  serverVersion: "0.1.8-nightly.20261105.4218",
  orchestrationProtocolVersion: 2,
};
const WARN = "[17:09:06.831] WARN (#20): Database migration history diverges";

type Reply = T3CommandResult | ((stdin?: string) => T3CommandResult);
const ok = (value: unknown): T3CommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: WARN,
});
const fail = (stderr: string, exitCode = 1): T3CommandResult => ({ exitCode, stdout: "", stderr });
const thread = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread-1",
  projectId: "project-1",
  title: plan.title,
  link: "https://app.t3.codes/threads/env-1/thread-1",
  status: "running",
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5-5",
  branch: "task/W-1",
  worktreePath: "/t3/worktrees/W-1",
  ...overrides,
});

class FakeT3 implements T3Process {
  readonly calls: { argv: readonly string[]; stdin?: string }[] = [];
  readonly replies = new Map<string, Reply[]>();

  on(command: string, ...replies: Reply[]) {
    this.replies.set(command, replies);
    return this;
  }

  async run(argv: readonly string[], stdin?: string) {
    this.calls.push(stdin === undefined ? { argv } : { argv, stdin });
    const command = argv.slice(1, 3).join(" ");
    const queue = this.replies.get(command) ?? this.replies.get(argv[1] ?? "");
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!reply) return fail(`unexpected ${argv.join(" ")}`);
    return typeof reply === "function" ? reply(stdin) : reply;
  }

  commands() {
    return this.calls.map(({ argv }) => argv.slice(1, 3).join(" "));
  }
}

function port(
  t3: FakeT3,
  options: { branches?: Set<string>; server?: () => Promise<unknown>; attempts?: number } = {},
) {
  const branches = options.branches ?? new Set<string>();
  return new T3HostPort({
    project: "/repo",
    cli: "/bin/t3",
    process: t3,
    server: options.server ?? (async () => descriptor),
    lanes: (query) =>
      ("lane" in query ? query.lane === lane : query.ticket === ticket)
        ? [{ lane, ticket, key: "W-1" }]
        : [],
    branchExists: async (branch) => branches.has(branch),
    readbackAttempts: options.attempts ?? 3,
    sleep: async () => {},
  });
}

const ready = () =>
  new FakeT3()
    .on("--version", { exitCode: 0, stdout: "t3 v0.1.8-nightly.20261105.4218\n", stderr: "" })
    .on("thread list", ok([]));

describe("T3 host preflight", () => {
  test("uses the CLI T3 Code exposes to its threads before t3 on PATH", () => {
    expect(hostT3Cli({ T3CODE_CLI_PATH: "/home/me/.t3/bin/t3" })).toBe("/home/me/.t3/bin/t3");
    expect(hostT3Cli({ T3CODE_CLI_PATH: "" })).toBe("t3");
    expect(hostT3Cli({})).toBe("t3");
  });

  test("a port without a configured CLI runs the one T3 Code exposes", async () => {
    const previous = process.env.T3CODE_CLI_PATH;
    process.env.T3CODE_CLI_PATH = "/home/me/.t3/bin/t3";
    try {
      const t3 = ready();
      await new T3HostPort({
        project: "/repo",
        process: t3,
        server: async () => descriptor,
        lanes: () => [],
        branchExists: async () => false,
      }).preflight();
      expect(t3.calls.map(({ argv }) => argv[0])).toEqual([
        "/home/me/.t3/bin/t3",
        "/home/me/.t3/bin/t3",
      ]);
    } finally {
      if (previous === undefined) delete process.env.T3CODE_CLI_PATH;
      else process.env.T3CODE_CLI_PATH = previous;
    }
  });

  test("accepts a CLI and server with the same version and protocol", async () => {
    const t3 = ready();
    await port(t3).preflight();
    expect(t3.calls.map(({ argv }) => argv)).toEqual([
      ["/bin/t3", "--version"],
      ["/bin/t3", "thread", "list", "--project", "/repo", "--json"],
    ]);
  });

  test("refuses a CLI whose version differs from the running server", async () => {
    const t3 = ready().on("--version", { exitCode: 0, stdout: "t3 v0.1.6\n", stderr: "" });
    expect((await rejection(port(t3).preflight())).message).toContain(
      "host_incompatible: t3 CLI v0.1.6 is not compatible with T3 server 0.1.8-nightly",
    );
    expect(t3.commands()).not.toContain("thread start");
  });

  test("refuses another orchestration protocol", async () => {
    const t3 = ready();
    const server = async () => ({ ...descriptor, orchestrationProtocolVersion: 3 });
    expect((await rejection(port(t3, { server }).preflight())).message).toContain(
      "host_incompatible",
    );
  });

  test("refuses when the CLI is missing", async () => {
    const t3 = new FakeT3().on("--version", fail("spawn ENOENT", -1));
    expect((await rejection(port(t3).preflight())).message).toContain(
      "host_unavailable: The t3 CLI at /bin/t3",
    );
  });

  test("refuses when the server is unreachable", async () => {
    const server = async () => {
      throw new Error("ENOENT server-runtime.json");
    };
    expect((await rejection(port(ready(), { server }).preflight())).message).toContain(
      "host_unavailable: The T3 server is not reachable: ENOENT server-runtime.json",
    );
  });

  test("refuses when the repository has no T3 project", async () => {
    const t3 = ready().on("thread list", fail(`${WARN}\nNo T3 Code project matches '/repo'.`));
    expect((await rejection(port(t3).preflight())).message).toContain(
      "host_unavailable: T3 cannot list threads for project /repo: No T3 Code project matches '/repo'.",
    );
  });
});

describe("T3 host launch", () => {
  test("binds project, base commit, branch and model, sending the message on stdin", async () => {
    const t3 = ready()
      .on("thread start", ok({ threadId: "thread-1", projectId: "project-1", runId: "run-1" }))
      .on("thread show", ok({ thread: thread(), messages: [] }));
    const result = await port(t3).launch({
      operation: [lane, "launch"],
      plan: { ...plan, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
    });
    expect(result).toMatchObject({
      state: "launched",
      session: {
        environment: "env-1",
        host: "t3",
        harness: "claudeAgent",
        session: "thread-1",
        lane,
        ticket,
      },
      view: { workspace: { path: "/t3/worktrees/W-1", branch: "task/W-1" } },
    });
    const start = t3.calls.find(({ argv }) => argv[2] === "start");
    expect(start).toEqual({
      argv: [
        "/bin/t3",
        "thread",
        "start",
        "/repo",
        "-",
        "--title",
        plan.title,
        "--worktree",
        base,
        "--branch",
        "task/W-1",
        "--provider",
        "claudeAgent",
        "--model",
        "claude-opus-5-5",
        "--json",
      ],
      stdin: "Lane procedure",
    });
  });

  test("never passes a branch name as the worktree base", async () => {
    const t3 = ready();
    expect(
      (
        await rejection(
          port(t3).launch({ operation: [lane, "launch"], plan: { ...plan, baseCommit: "main" } }),
        )
      ).message,
    ).toContain("exact fetched base commit");
    expect(t3.commands()).not.toContain("thread start");
  });

  test("refuses an existing branch before starting a thread", async () => {
    const t3 = ready();
    expect(
      (
        await rejection(
          port(t3, { branches: new Set(["task/W-1"]) }).launch({
            operation: [lane, "launch"],
            plan,
          }),
        )
      ).message,
    ).toContain("branch_exists: Branch task/W-1 already exists");
    expect(t3.commands()).not.toContain("thread start");
  });

  test("a branch check that cannot read origin refuses before starting a thread", async () => {
    const t3 = ready();
    const subject = new T3HostPort({
      project: "/repo",
      cli: "/bin/t3",
      process: t3,
      server: async () => descriptor,
      lanes: () => [],
      branchExists: async () => {
        throw new Error("Cannot read origin branches");
      },
    });
    expect(
      (await rejection(subject.launch({ operation: [lane, "launch"], plan }))).message,
    ).toContain("host_unavailable: Cannot verify branch task/W-1: Cannot read origin branches");
    expect(t3.commands()).not.toContain("thread start");
  });

  test("exit 0 without a readable thread is ambiguous", async () => {
    const t3 = ready().on("thread start", { exitCode: 0, stdout: "", stderr: WARN });
    expect(await port(t3).launch({ operation: [lane, "launch"], plan })).toEqual({
      state: "ambiguous",
      reason: "t3 thread start exited 0 without a readable thread",
      acknowledged: true,
    });
  });

  test("a thread id that never reads back is ambiguous", async () => {
    const t3 = ready()
      .on("thread start", ok({ threadId: "thread-1", projectId: "project-1", runId: null }))
      .on("thread show", fail("Thread not found"));
    expect(await port(t3).launch({ operation: [lane, "launch"], plan })).toEqual({
      state: "ambiguous",
      reason: "T3 thread thread-1 is not readable",
      acknowledged: true,
    });
    expect(t3.commands().filter((command) => command === "thread show")).toHaveLength(3);
  });

  test("a thread that fails after exit 0 is ambiguous", async () => {
    const t3 = ready()
      .on("thread start", ok({ threadId: "thread-1", projectId: "project-1", runId: "run-1" }))
      .on(
        "thread show",
        ok({ thread: thread({ status: "failed", worktreePath: null }), messages: [] }),
      );
    expect(await port(t3).launch({ operation: [lane, "launch"], plan })).toEqual({
      state: "ambiguous",
      reason: "T3 thread thread-1 ended failed",
      acknowledged: true,
    });
  });

  test("a thread bound to another branch is ambiguous", async () => {
    const t3 = ready()
      .on("thread start", ok({ threadId: "thread-1", projectId: "project-1", runId: "run-1" }))
      .on("thread show", ok({ thread: thread({ branch: "t3/abc" }), messages: [] }));
    expect(await port(t3).launch({ operation: [lane, "launch"], plan })).toMatchObject({
      state: "ambiguous",
      reason: "T3 thread thread-1 is on t3/abc, not task/W-1",
    });
  });

  test("a thread running another model than the plan selected is ambiguous", async () => {
    const t3 = ready()
      .on("thread start", ok({ threadId: "thread-1", projectId: "project-1", runId: "run-1" }))
      .on("thread show", ok({ thread: thread({ model: "claude-haiku-5-5" }), messages: [] }));
    expect(
      await port(t3).launch({
        operation: [lane, "launch"],
        plan: { ...plan, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
      }),
    ).toMatchObject({
      state: "ambiguous",
      reason:
        "T3 thread thread-1 runs claudeAgent/claude-haiku-5-5, not claudeAgent/claude-opus-5-5",
      acknowledged: true,
    });
  });

  test("waits for the worktree to bind while the thread prepares", async () => {
    const t3 = ready()
      .on("thread start", ok({ threadId: "thread-1", projectId: "project-1", runId: "run-1" }))
      .on(
        "thread show",
        ok({
          thread: thread({ status: "preparing", branch: null, worktreePath: null }),
          messages: [],
        }),
        ok({ thread: thread(), messages: [] }),
      );
    expect((await port(t3).launch({ operation: [lane, "launch"], plan })).state).toBe("launched");
  });
});

test("a non-zero start is not acknowledged", async () => {
  const t3 = ready().on("thread start", fail("No T3 Code project matches '/repo'."));
  expect(await port(t3).launch({ operation: [lane, "launch"], plan })).toEqual({
    state: "ambiguous",
    reason: "t3 thread start failed: No T3 Code project matches '/repo'.",
    acknowledged: false,
  });
});

describe("T3 host find, read and steer", () => {
  test("finds the ticket's threads through list", async () => {
    const t3 = ready().on(
      "thread list",
      ok([
        thread(),
        thread({ threadId: "other", title: "W-10: Other" }),
        thread({ threadId: "t2" }),
      ]),
    );
    const sessions = await port(t3).find({ ticket });
    expect(sessions.map((found) => found.session)).toEqual(["thread-1", "t2"]);
    expect(await port(t3).find({ lane })).toHaveLength(2);
    expect(
      await port(t3).find({ ticket: ticketRefSchema.parse("jira:acme:W:ticket:W-2") }),
    ).toEqual([]);
  });

  test("reads status, workspace and messages through show", async () => {
    const t3 = ready().on(
      "thread show",
      ok({ thread: thread(), messages: [{ role: "assistant", runId: "r", text: "Attached" }] }),
    );
    const [found] = await port(ready().on("thread list", ok([thread()]))).find({ lane });
    if (!found) throw new Error("expected a session");
    expect(await port(t3).read(found)).toEqual({
      session: found,
      status: "running",
      link: "https://app.t3.codes/threads/env-1/thread-1",
      workspace: { path: "/t3/worktrees/W-1", branch: "task/W-1" },
      messages: [{ role: "assistant", text: "Attached" }],
    });
  });

  test("steers through send with the message on stdin", async () => {
    const t3 = ready().on("thread send", ok({ threadId: "thread-1", delivery: "queued" }));
    const [found] = await port(ready().on("thread list", ok([thread()]))).find({ lane });
    if (!found) throw new Error("expected a session");
    expect(
      await port(t3).steer({ operation: [lane, "steer:1"], session: found, message: "Rebase" }),
    ).toEqual({ state: "delivered" });
    expect(t3.calls.at(-1)).toEqual({
      argv: ["/bin/t3", "thread", "send", "thread-1", "-", "--json"],
      stdin: "Rebase",
    });
  });

  test("an unconfirmed send is ambiguous", async () => {
    const t3 = ready().on("thread send", fail("server unreachable"));
    const [found] = await port(ready().on("thread list", ok([thread()]))).find({ lane });
    if (!found) throw new Error("expected a session");
    expect(
      await port(t3).steer({ operation: [lane, "steer:1"], session: found, message: "Rebase" }),
    ).toEqual({
      state: "ambiguous",
      reason: "t3 thread send was not confirmed: server unreachable",
    });
  });
});

describe("T3 host recovery", () => {
  test("finds the launched thread by its title and verifies its binding", async () => {
    const t3 = ready()
      .on("thread list", ok([thread()]))
      .on("thread show", ok({ thread: thread(), messages: [] }));
    expect(await port(t3).recover({ operation: [lane, "launch"], plan })).toMatchObject({
      state: "found",
      session: { session: "thread-1" },
    });
    expect(t3.commands()).not.toContain("thread start");
  });

  test("proves non-launch only when no thread and no branch exist", async () => {
    expect(await port(ready()).recover({ operation: [lane, "launch"], plan })).toEqual({
      state: "not_launched",
      evidence: "No T3 thread titled W-1: Ship it and no branch task/W-1",
    });
    expect(
      await port(ready(), { branches: new Set(["task/W-1"]) }).recover({
        operation: [lane, "launch"],
        plan,
      }),
    ).toEqual({ state: "ambiguous", reason: "Branch task/W-1 exists without a T3 thread" });
  });

  test("an unreadable list or duplicate threads stay ambiguous", async () => {
    const unreadable = ready().on("thread list", fail("down"));
    expect((await port(unreadable).recover({ operation: [lane, "launch"], plan })).state).toBe(
      "ambiguous",
    );
    const duplicate = ready().on("thread list", ok([thread(), thread({ threadId: "t2" })]));
    expect(await port(duplicate).recover({ operation: [lane, "launch"], plan })).toEqual({
      state: "ambiguous",
      reason: "2 T3 threads match W-1: Ship it",
    });
  });
});
