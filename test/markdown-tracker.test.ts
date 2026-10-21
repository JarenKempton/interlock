import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { findAdapter } from "../src/adapters/registry.ts";
import {
  formatMarkdownTracker,
  MarkdownTrackerAdapter,
  type MarkdownTrackerClock,
  type MarkdownTrackerDocument,
  MarkdownTrackerLockError,
  MarkdownTrackerValidationError,
  parseMarkdownTracker,
} from "../src/adapters/trackers/markdown.ts";
import { ClaimCollisionError } from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  mapRefSchema,
  ticketRefSchema,
  workspaceRefSchema,
} from "../src/domain/identifiers.ts";

const map = mapRefSchema.parse("markdown:local:fixtures:map:map-1");
const otherMap = mapRefSchema.parse("markdown:local:fixtures:map:map-2");
const workspace = workspaceRefSchema.parse("markdown:local:fixtures");
const blocker = ticketRefSchema.parse("markdown:local:fixtures:ticket:a");
const ticket = ticketRefSchema.parse("markdown:local:fixtures:ticket:b");
const owner = actorRefSchema.parse("jaren");
const foreignOwner = actorRefSchema.parse("other-human");
const directories: string[] = [];
const now = new Date("2026-08-11T12:00:00.000Z");
const clock: MarkdownTrackerClock = { now: () => new Date(now) };

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function document(): MarkdownTrackerDocument {
  return {
    format: "interlock-markdown-tracker",
    version: 1,
    workspace,
    maps: [
      { ref: map, title: "Reference map", order: 0, context: [] },
      { ref: otherMap, title: "Other map", order: 1, context: [] },
    ],
    tickets: [
      {
        ref: blocker,
        map,
        title: "First",
        kind: "research",
        state: "open",
        status: "To Do",
        order: 0,
        comments: [],
        artifacts: [],
        claimHistory: [],
      },
      {
        ref: ticket,
        map: otherMap,
        title: "Second",
        kind: "task",
        state: "open",
        status: "To Do",
        order: 1,
        dependencies: [{ blocking: blocker, blocked: ticket, kind: "blocks" }],
        comments: [],
        artifacts: [],
        claimHistory: [],
      },
    ],
  };
}

async function fixture(prose = "Human preface.\n\n", fixtureClock = clock) {
  const directory = await mkdtemp(join(tmpdir(), "interlock-markdown-"));
  directories.push(directory);
  const path = join(directory, "tracker.md");
  await writeFile(path, `${prose}${formatMarkdownTracker(document())}`);
  return new MarkdownTrackerAdapter(path, fixtureClock);
}

const claimRequest = (expectedVersion: string, claimant = owner) => ({
  claim: "interlock-claim:first" as const,
  run: "interlock-run:first" as const,
  ticket: blocker,
  owner: claimant,
  leaseExpiresAt: "2026-08-11T12:15:00.000Z",
  expectedVersion,
});

describe("MarkdownTrackerAdapter", () => {
  test("line-anchored fence discovery and escaped rendered values resist fence injection", async () => {
    const value = document();
    const firstMap = value.maps[0];
    if (!firstMap) throw new Error("fixture map missing");
    firstMap.title = "Map with `ticks`\n```interlock-tracker";
    firstMap.context = ["gist\n```interlock-tracker\nmore"];
    const source = `Prose mentions x \`\`\`interlock-tracker inline.\n\n${formatMarkdownTracker(value)}`;
    expect(parseMarkdownTracker(source)).toEqual(value);
    expect(source).toContain("\\```interlock-tracker");
  });

  test("preserves human prose while validating the final replacement", async () => {
    const adapter = await fixture("# Hand-authored notes\n\nKeep this paragraph.\n\n");
    const snapshot = await adapter.snapshotClaimState(blocker);
    await adapter.comment(blocker, "audit", snapshot.version);
    const source = await readFile(adapter.path, "utf8");
    expect(source).toStartWith("# Hand-authored notes\n\nKeep this paragraph.\n\n");
    expect(parseMarkdownTracker(source).tickets[0]?.comments).toEqual(["audit"]);
  });

  test("validates nested hand edits with an explicit path", () => {
    const value = z
      .looseObject({ tickets: z.array(z.record(z.string(), z.unknown())) })
      .parse(document());
    const firstTicket = value.tickets[0];
    if (!firstTicket) throw new Error("fixture ticket missing");
    firstTicket.comments = [42];
    const source = `\`\`\`interlock-tracker\n${JSON.stringify(value)}\n\`\`\``;
    expect(() => parseMarkdownTracker(source)).toThrow(
      expect.objectContaining({
        name: "MarkdownTrackerValidationError",
        code: "invalid_markdown_tracker",
        path: "document.tickets[0].comments[0]",
      }),
    );
  });

  test.each([
    [
      "unqualified workspace",
      (value: MarkdownTrackerDocument) => Object.assign(value, { workspace: "fixtures" }),
    ],
    [
      "wrong adapter",
      (value: MarkdownTrackerDocument) => {
        const target = value.maps[0];
        if (!target) throw new Error("fixture map missing");
        target.ref = mapRefSchema.parse("jira:local:fixtures:map:map-1");
      },
    ],
    [
      "wrong kind",
      (value: MarkdownTrackerDocument) => {
        const target = value.tickets[0];
        if (!target) throw new Error("fixture ticket missing");
        target.ref = ticketRefSchema.parse("markdown:local:fixtures:map:a");
      },
    ],
    [
      "cross-workspace ticket",
      (value: MarkdownTrackerDocument) => {
        const target = value.tickets[0];
        if (!target) throw new Error("fixture ticket missing");
        target.ref = ticketRefSchema.parse("markdown:local:elsewhere:ticket:a");
      },
    ],
    [
      "cross-workspace dependency",
      (value: MarkdownTrackerDocument) => {
        const dependency = value.tickets[1]?.dependencies?.[0];
        if (!dependency) throw new Error("fixture dependency missing");
        dependency.blocking = ticketRefSchema.parse("markdown:local:elsewhere:ticket:a");
      },
    ],
  ])("rejects %s references", (_name, mutate) => {
    const value = document();
    mutate(value);
    const source = `\`\`\`interlock-tracker\n${JSON.stringify(value)}\n\`\`\``;
    expect(() => parseMarkdownTracker(source)).toThrow(MarkdownTrackerValidationError);
  });

  test("uses the injected clock for claim, renewal, and stale reclaim", async () => {
    let current = new Date(now);
    const adapter = await fixture("Human preface.\n\n", { now: () => new Date(current) });
    const before = await adapter.snapshotClaimState(blocker);
    const request = claimRequest(before.version);
    await adapter.claim(request);
    expect((await adapter.read()).tickets[0]?.claim?.claimedAt).toBe(now.toISOString());
    const claimedSnapshot = await adapter.snapshotClaimState(blocker);
    await expect(
      adapter.renewLease({
        claim: request.claim,
        ticket: blocker,
        expectedVersion: claimedSnapshot.version,
        leaseExpiresAt: "2026-08-11T11:59:59.000Z",
      }),
    ).rejects.toThrow("future timestamp");
    current = new Date("2026-08-11T12:16:00.000Z");
    const staleSnapshot = await adapter.snapshotClaimState(blocker);
    const reclaim = {
      staleClaim: request.claim,
      claim: "interlock-claim:second" as const,
      run: "interlock-run:second" as const,
      ticket: blocker,
      owner,
      authorizedBy: owner,
      leaseExpiresAt: "2026-08-11T12:30:00.000Z",
      expectedVersion: staleSnapshot.version,
      originalSnapshot: before,
    };
    await adapter.reclaim(reclaim);
    await adapter.verifyReclaimed(reclaim);
    const reclaimed = (await adapter.read()).tickets[0];
    expect(reclaimed?.claim?.claimedAt).toBe(current.toISOString());
    expect(reclaimed?.claim).toMatchObject({ ref: reclaim.claim, supersedes: request.claim });
    expect(reclaimed?.claimHistory).toEqual([
      expect.objectContaining({
        ref: request.claim,
        status: "superseded",
        supersededBy: reclaim.claim,
      }),
    ]);
  });

  test("restore is retry-safe, including compensation before the claim write lands", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    const restore = {
      ticket: blocker,
      claim: "interlock-claim:first" as const,
      originalSnapshot: before,
    };
    await adapter.restoreClaimState(restore);
    await adapter.verifyRestored(restore);
    expect((await adapter.snapshotClaimState(blocker)).version).toBe(before.version);
    const request = claimRequest(before.version);
    await adapter.claim(request);
    await adapter.restoreClaimState(restore);
    await adapter.restoreClaimState(restore);
    await adapter.verifyRestored(restore);
  });

  test("resolve rejects stale versions and foreign active claims without mutation", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    await adapter.claim(claimRequest(before.version, foreignOwner));
    const claimed = await adapter.snapshotClaimState(blocker);
    const baseline = await adapter.read();
    await expect(
      adapter.resolve({ ticket: blocker, expectedVersion: before.version, resolution: "stale" }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
    await expect(
      adapter.resolve({
        ticket: blocker,
        expectedVersion: claimed.version,
        owner,
        claim: "interlock-claim:first",
        resolution: "foreign",
      }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
    expect(await adapter.read()).toEqual(baseline);
  });

  test("resolve with matching ownership closes and preserves resolution evidence", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    const claim = claimRequest(before.version);
    await adapter.claim(claim);
    const current = await adapter.snapshotClaimState(blocker);
    await adapter.resolve({
      ticket: blocker,
      expectedVersion: current.version,
      owner,
      claim: claim.claim,
      resolution: "Evidence passed.",
      artifacts: ["https://example.test/pr/1"],
    });
    expect((await adapter.frontier({ map: otherMap })).map((item) => item.ref)).toEqual([ticket]);
  });

  test("orphan lock has explicit token-guarded recovery; live and unknown locks are retained", async () => {
    const adapter = await fixture();
    const lockPath = `${adapter.path}.lock`;
    const createdAt = now.toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ token: "live", pid: process.pid, host: hostname(), createdAt }),
    );
    expect(await adapter.inspectLock()).toMatchObject({ state: "live", owner: { token: "live" } });
    await expect(adapter.reclaimOrphanedLock("live")).rejects.toBeInstanceOf(
      MarkdownTrackerLockError,
    );
    expect(await readFile(lockPath, "utf8")).toContain("live");
    await writeFile(
      lockPath,
      JSON.stringify({ token: "remote", pid: 1, host: "another-host", createdAt }),
    );
    expect(await adapter.inspectLock()).toMatchObject({ state: "unknown" });
    await expect(adapter.reclaimOrphanedLock("remote")).rejects.toBeInstanceOf(
      MarkdownTrackerLockError,
    );
    await writeFile(
      lockPath,
      JSON.stringify({ token: "orphan", pid: 2_147_483_647, host: hostname(), createdAt }),
    );
    expect(await adapter.inspectLock()).toMatchObject({ state: "orphaned" });
    await adapter.reclaimOrphanedLock("orphan");
    expect(await adapter.inspectLock()).toEqual({ state: "absent" });
  });

  test("durable replacement leaves a parseable target and no temporary files", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    await adapter.comment(blocker, `replacement on ${process.platform}`, before.version);
    expect(parseMarkdownTracker(await readFile(adapter.path, "utf8")).tickets[0]?.comments).toEqual(
      [`replacement on ${process.platform}`],
    );
    const files = await readdir(join(adapter.path, ".."));
    expect(files.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("every advertised capability has behavioral conformance evidence", async () => {
    const adapter = await fixture();
    expect(findAdapter("markdown").available).toBeFalse();
    const advertised = Object.keys(await adapter.describe()).toSorted();
    const proven = [
      "artifact_links",
      "atomic_assignment",
      "claim_comments",
      "claim_identity",
      "conditional_update",
      "cross_map_dependencies",
      "lease_metadata",
      "native_dependencies",
      "native_maps",
      "resolution_comments",
      "workflow_transition",
    ].toSorted();
    expect(advertised).toEqual(proven);
    expect((await adapter.frontier()).map((item) => item.ref)).toEqual([blocker]);
    const before = await adapter.snapshotClaimState(blocker);
    const claim = claimRequest(before.version);
    await adapter.claim(claim);
    await adapter.verifyClaim(claim);
    const claimed = await adapter.read();
    expect(claimed.tickets[0]).toMatchObject({
      status: "In Progress",
      comments: [expect.stringContaining("Claimed")],
    });
    const snapshot = await adapter.snapshotClaimState(blocker);
    const renewal = {
      claim: claim.claim,
      ticket: blocker,
      expectedVersion: snapshot.version,
      leaseExpiresAt: "2026-08-11T12:20:00.000Z",
    };
    await adapter.renewLease(renewal);
    await adapter.verifyLease(renewal);
    const renewed = await adapter.snapshotClaimState(blocker);
    await adapter.resolve({
      ticket: blocker,
      expectedVersion: renewed.version,
      owner,
      claim: claim.claim,
      resolution: "done",
      artifacts: ["artifact"],
    });
    const resolved = await adapter.read();
    expect(resolved.tickets[0]).toMatchObject({
      state: "closed",
      status: "Done",
      artifacts: ["artifact"],
      comments: [expect.any(String), "Resolution: done"],
    });
    const mapVersion = String(resolved.version);
    await adapter.appendMapContext(map, blocker, "gist", mapVersion);
    expect((await adapter.read()).maps[0]?.context).toHaveLength(1);
    expect((await adapter.frontier({ map: otherMap })).map((item) => item.ref)).toEqual([ticket]);
  });
});

test("Markdown ticket context survives format and parse", () => {
  const input = document();
  const first = input.tickets[0];
  if (!first) throw new Error("Missing fixture ticket");
  first.description = "Outcome and instructions";
  first.acceptanceCriteria = "Verify full context";
  expect(parseMarkdownTracker(formatMarkdownTracker(input)).tickets[0]).toMatchObject({
    title: "First",
    description: "Outcome and instructions",
    acceptanceCriteria: "Verify full context",
  });
});
