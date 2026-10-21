import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../src/cli.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { Ticket } from "../src/domain/model.ts";
import { parseTickets } from "../src/domain/tickets.ts";
import {
  FakeStatusRepairService,
  type StatusRepairAdapterIdentity,
  type StatusRepairReceiptStore,
  type StatusRepairRecoveryReceipt,
  type StatusRepairService,
  statusRepairAdapterBinding,
} from "../src/reconciliation/status-repair.ts";

const map = mapRefSchema.parse("jira:x:W:map:M");
const scope = String(map);

class MemoryReceipts implements StatusRepairReceiptStore {
  allocations = 0;
  creates = 0;
  updates = 0;
  constructor(
    readonly records = new Map<string, StatusRepairRecoveryReceipt>(),
    readonly failCreate = false,
  ) {}
  async allocateRef(): Promise<string> {
    this.allocations += 1;
    return "status-repair:test-receipt";
  }
  async create(ref: string, receipt: StatusRepairRecoveryReceipt): Promise<void> {
    this.creates += 1;
    if (this.failCreate) throw new Error("receipt disk unavailable");
    if (this.records.has(ref)) throw new Error("receipt already exists");
    this.records.set(ref, structuredClone(receipt));
  }
  async load(ref: string): Promise<StatusRepairRecoveryReceipt | undefined> {
    return structuredClone(this.records.get(ref));
  }
  async update(ref: string, receipt: StatusRepairRecoveryReceipt): Promise<void> {
    this.updates += 1;
    this.records.set(ref, structuredClone(receipt));
  }
}

function changedAdapter(
  adapter: StatusRepairAdapterIdentity,
  change: "adapter" | "instance" | "capabilities" | "versionContract",
): StatusRepairAdapterIdentity {
  if (change === "adapter") return { ...adapter, adapter: "other" };
  if (change === "instance") return { ...adapter, instance: "other" };
  if (change === "capabilities") {
    return { ...adapter, capabilities: { conditional_update: true } };
  }
  return {
    ...adapter,
    versionContract: { ...adapter.versionContract, name: "other-contract" },
  };
}

function refreshIdentityService(
  fake: FakeStatusRepairService,
  change: "adapter" | "instance" | "capabilities" | "versionContract",
): StatusRepairService {
  return {
    adapter: fake.adapter,
    repair: fake.repair.bind(fake),
    refresh: async (tickets) => {
      const result = await fake.refresh(tickets);
      return { ...result, adapter: changedAdapter(result.adapter, change) };
    },
  };
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-reconcile-"));
  const blocker: Ticket = {
    ref: ticketRefSchema.parse("jira:x:W:ticket:A"),
    map,
    kind: "task",
    state: "open",
    status: "To Do",
    order: 0,
    metadata: { version: "v-A" },
  };
  const blocked: Ticket = {
    ...blocker,
    ref: ticketRefSchema.parse("jira:x:W:ticket:B"),
    order: 1,
    metadata: { version: "v-B" },
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: ticketRefSchema.parse("jira:x:W:ticket:B"),
        kind: "blocks",
      },
    ],
  };
  const active: Ticket = {
    ...blocked,
    ref: ticketRefSchema.parse("jira:x:W:ticket:C"),
    status: "In Review",
    order: 2,
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: ticketRefSchema.parse("jira:x:W:ticket:C"),
        kind: "blocks",
      },
    ],
  };
  const unmanaged: Ticket = {
    ...blocked,
    ref: ticketRefSchema.parse("jira:x:W:ticket:D"),
    status: "Backlog",
    assignee: actorRefSchema.parse("human"),
    order: 3,
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: ticketRefSchema.parse("jira:x:W:ticket:D"),
        kind: "blocks",
      },
    ],
  };
  const path = join(directory, "tickets.json");
  writeFileSync(path, JSON.stringify([blocker, blocked, active, unmanaged]));
  return path;
}

function partialFixture(): string {
  const path = fixture();
  const tickets = parseTickets(JSON.parse(readFileSync(path, "utf8")));
  const blocker = tickets[0];
  const template = tickets[1];
  if (!blocker || !template) throw new Error("Missing fixture tickets");
  tickets.push({
    ...template,
    ref: ticketRefSchema.parse("jira:x:W:ticket:E"),
    order: 4,
    metadata: { version: "v-E" },
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: ticketRefSchema.parse("jira:x:W:ticket:E"),
        kind: "blocks",
      },
    ],
  });
  writeFileSync(path, JSON.stringify(tickets));
  return path;
}

describe("reconcile statuses CLI", () => {
  test("audits transitions and protected-state drift as a structured receipt", async () => {
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--json"],
      output.push.bind(output),
    );
    const receipt = JSON.parse(output[0] ?? "null");
    expect(receipt.action).toBe("statuses_audited");
    expect(receipt.transitions).toHaveLength(1);
    expect(receipt.drift).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("jira:x:W:ticket:D");
  });

  test("dry-run plans repair without mutation and live repair requires a verifier", async () => {
    const output: string[] = [];
    let calls = 0;
    const verifier = new FakeStatusRepairService(new Map());
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--dry-run", "--json"],
      output.push.bind(output),
      {
        statusRepair: {
          adapter: verifier.adapter,
          repair: async () => {
            calls += 1;
            return verifier.repair([]);
          },
          refresh: async () => verifier.refresh([]),
        },
      },
    );
    expect(calls).toBe(0);
    expect(JSON.parse(output[0] ?? "null").action).toBe("status_repair_planned");
    await expect(
      run(["reconcile", "statuses", scope, "--input", fixture(), "--repair"], () => undefined),
    ).rejects.toThrow("conditional status mutation and verification service");
  });

  test("repair delegates the exact conditional transition plan", async () => {
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
      output.push.bind(output),
      {
        statusRepair: new FakeStatusRepairService(
          new Map([["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }]]),
        ),
      },
    );
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "statuses_repaired",
      repairOutcomes: [{ outcome: "verified" }],
    });
  });

  test("does not report repaired when an outcome is ambiguous", async () => {
    const output: string[] = [];
    const receipts = new MemoryReceipts();
    await expect(
      run(
        ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
        output.push.bind(output),
        {
          statusRepair: new FakeStatusRepairService(
            new Map([
              ["jira:x:W:ticket:B", { status: "To Do", version: "v-B", outcome: "ambiguous" }],
            ]),
          ),
          statusRepairReceipts: receipts,
        },
      ),
    ).resolves.toBeUndefined();
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "status_repair_recovery_required",
      dispositions: [{ outcome: "ambiguous" }],
    });
  });

  test("fails closed when recovery receipt persistence fails", async () => {
    const receipts = new MemoryReceipts(new Map(), true);
    const output: string[] = [];
    await expect(
      run(
        ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
        output.push.bind(output),
        {
          statusRepair: new FakeStatusRepairService(
            new Map([
              ["jira:x:W:ticket:B", { status: "To Do", version: "v-B", outcome: "collision" }],
            ]),
          ),
          statusRepairReceipts: receipts,
        },
      ),
    ).rejects.toMatchObject({
      name: "StatusRepairPersistenceError",
      evidence: { rawOutcomes: [{ outcome: "collision" }] },
    });
    expect(receipts.records.size).toBe(0);
    expect(output).toEqual([]);
  });

  test("persists complete partial-success recovery and exact retry command", async () => {
    const receipts = new MemoryReceipts();
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      output.push.bind(output),
      {
        statusRepair: new FakeStatusRepairService(
          new Map([
            ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
            ["jira:x:W:ticket:E", { status: "To Do", version: "changed" }],
          ]),
        ),
        statusRepairReceipts: receipts,
      },
    );
    const receipt = JSON.parse(output[0] ?? "null");
    expect(receipt).toMatchObject({
      action: "status_repair_recovery_required",
      requested: [{ ticket: "jira:x:W:ticket:B" }, { ticket: "jira:x:W:ticket:E" }],
      dispositions: [{ outcome: "verified" }, { outcome: "collision" }],
      recoveryArgv: [
        "reconcile",
        "statuses",
        scope,
        "--recover",
        "status-repair:test-receipt",
        "--json",
      ],
      refreshEvidence: [],
    });
    expect(receipts.records.size).toBe(1);
    expect(receipts.allocations).toBe(1);
    expect(receipts.creates).toBe(1);
    expect(receipts.updates).toBe(0);
    expect(receipts.records.get(receipt.ref)).toMatchObject({
      ref: receipt.ref,
      adapter: {
        adapter: "fake",
        instance: "test",
        capabilities: { conditional_update: true, workflow_transition: true },
        versionContract: "opaque-change-token-v1",
      },
      recoveryArgv: ["reconcile", "statuses", scope, "--recover", receipt.ref, "--json"],
    });
  });

  test("executes durable recovery, retries only unresolved work, and is idempotent", async () => {
    const receiptRows = new Map<string, StatusRepairRecoveryReceipt>();
    const receipts = new MemoryReceipts(receiptRows);
    const records = new Map([
      ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
      ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
    ]);
    const initialService = new FakeStatusRepairService(records);
    const initialOutput: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      initialOutput.push.bind(initialOutput),
      { statusRepair: initialService, statusRepairReceipts: receipts },
    );
    expect(initialService.repairCalls.map((call) => call.map(String))).toEqual([
      ["jira:x:W:ticket:B", "jira:x:W:ticket:E"],
    ]);
    const restartedReceipts = new MemoryReceipts(receiptRows);
    const service = new FakeStatusRepairService(records);
    const output: string[] = [];
    const recoveryArgv = z
      .array(z.string())
      .parse(JSON.parse(initialOutput[0] ?? "null").recoveryArgv);
    await run(recoveryArgv, output.push.bind(output), {
      statusRepair: service,
      statusRepairReceipts: restartedReceipts,
    });
    expect(service.repairCalls[0]?.map(String)).toEqual(["jira:x:W:ticket:E"]);
    expect(service.refreshCalls[0]?.map(String)).toEqual([
      "jira:x:W:ticket:B",
      "jira:x:W:ticket:E",
    ]);
    const recoveredReceipt = JSON.parse(output[0] ?? "null");
    expect(recoveredReceipt).toMatchObject({
      action: "status_repair_recovered",
      dispositions: [
        { outcome: "verified", reconciled: true },
        { outcome: "verified", expectedVersion: "current" },
      ],
    });
    expect(recoveredReceipt.refreshEvidence[0].observations).toHaveLength(2);
    await run(
      ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
      () => undefined,
      { statusRepair: service, statusRepairReceipts: restartedReceipts },
    );
    expect(service.repairCalls).toHaveLength(1);
  });

  test("fails closed for missing receipt and persists ambiguous refresh attention", async () => {
    const receipts = new MemoryReceipts();
    const service = new FakeStatusRepairService(new Map());
    await expect(
      run(["reconcile", "statuses", scope, "--recover", "missing", "--json"], () => undefined, {
        statusRepair: service,
        statusRepairReceipts: receipts,
      }),
    ).rejects.toThrow("not found");

    const records = new Map<string, { status: string; version: string; outcome?: "ambiguous" }>([
      ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
      ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
    ]);
    const partial = new FakeStatusRepairService(records);
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      () => undefined,
      { statusRepair: partial, statusRepairReceipts: receipts },
    );
    const unresolved = records.get("jira:x:W:ticket:E");
    if (!unresolved) throw new Error("missing fake record");
    unresolved.outcome = "ambiguous";
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
      output.push.bind(output),
      { statusRepair: partial, statusRepairReceipts: receipts },
    );
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "attention_required",
      dispositions: [{ outcome: "verified", reconciled: true }, { outcome: "ambiguous" }],
    });
    expect(receipts.records.get("status-repair:test-receipt")?.action).toBe("attention_required");
  });

  test("fails closed when a recovered receipt cannot be persisted", async () => {
    const receipts = new MemoryReceipts();
    const service = new FakeStatusRepairService(
      new Map([
        ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
        ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
      ]),
    );
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      () => undefined,
      { statusRepair: service, statusRepairReceipts: receipts },
    );
    const failingStore: StatusRepairReceiptStore = {
      allocateRef: receipts.allocateRef.bind(receipts),
      create: receipts.create.bind(receipts),
      load: receipts.load.bind(receipts),
      update: () => {
        throw new Error("recovery receipt unavailable");
      },
    };
    const output: string[] = [];
    await expect(
      run(
        ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
        output.push.bind(output),
        { statusRepair: service, statusRepairReceipts: failingStore },
      ),
    ).rejects.toThrow("recovery receipt unavailable");
    expect(output).toEqual([]);
  });

  test("binds recovery to the original adapter before retry mutation", async () => {
    for (const change of ["adapter", "instance", "capabilities", "versionContract"] as const) {
      const receipts = new MemoryReceipts();
      const records = new Map([
        ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
        ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
      ]);
      await run(
        ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
        () => undefined,
        {
          statusRepair: new FakeStatusRepairService(records),
          statusRepairReceipts: receipts,
        },
      );
      const retry = new FakeStatusRepairService(records);
      const output: string[] = [];
      await run(
        ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
        output.push.bind(output),
        {
          statusRepair: refreshIdentityService(retry, change),
          statusRepairReceipts: receipts,
        },
      );
      expect(retry.repairCalls).toHaveLength(0);
      expect(JSON.parse(output[0] ?? "null")).toMatchObject({
        action: "attention_required",
        diagnostics: [{ detail: { reason: "status repair adapter binding mismatch" } }],
      });
      const stored = receipts.records.get("status-repair:test-receipt");
      const observedBinding = statusRepairAdapterBinding(changedAdapter(retry.adapter, change));
      expect(stored?.action).toBe("attention_required");
      expect(stored?.diagnostics.at(-1)?.detail).toEqual({
        reason: "status repair adapter binding mismatch",
        stage: "refresh",
        expected: stored?.adapter,
        observed: observedBinding,
      });
      expect(stored?.refreshEvidence.at(-1)?.adapter).toEqual(observedBinding);
    }
  });

  test("emits nothing when adapter-mismatch attention cannot be persisted", async () => {
    const receipts = new MemoryReceipts();
    const records = new Map([
      ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
      ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
    ]);
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      () => undefined,
      { statusRepair: new FakeStatusRepairService(records), statusRepairReceipts: receipts },
    );
    const retry = new FakeStatusRepairService(records);
    const output: string[] = [];
    await expect(
      run(
        ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
        output.push.bind(output),
        {
          statusRepair: refreshIdentityService(retry, "adapter"),
          statusRepairReceipts: {
            allocateRef: receipts.allocateRef.bind(receipts),
            create: receipts.create.bind(receipts),
            load: receipts.load.bind(receipts),
            update: () => {
              throw new Error("mismatch receipt unavailable");
            },
          },
        },
      ),
    ).rejects.toThrow("mismatch receipt unavailable");
    expect(retry.repairCalls).toHaveLength(0);
    expect(output).toEqual([]);
  });

  test("requires a recovery receipt reference", async () => {
    await expect(
      run(["reconcile", "statuses", scope, "--recover"], () => undefined),
    ).rejects.toThrow("--recover receipt-ref");
  });

  test("requires and validates the positional qualified scope", async () => {
    await expect(
      run(["reconcile", "statuses", "--input", fixture()], () => undefined),
    ).rejects.toThrow("Invalid arguments");
    await expect(
      run(["reconcile", "statuses", "interlock-run:123", "--input", fixture()], () => undefined),
    ).rejects.toThrow("not a frontier scope");
    await expect(
      run(["reconcile", "statuses", "not-a-reference", "--input", fixture()], () => undefined),
    ).rejects.toThrow();
  });

  test("rejects dry-run without repair", async () => {
    await expect(
      run(["reconcile", "statuses", scope, "--input", fixture(), "--dry-run"], () => undefined),
    ).rejects.toThrow("--dry-run requires --repair");
  });
});
