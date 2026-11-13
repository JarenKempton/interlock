import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueRef } from "../../../src/adapters/trackers/github/refs.ts";
import { ghCliTransport } from "../../../src/adapters/trackers/github/transport.ts";
import { signedInLaneTracker } from "../../../src/app/tracker/signed-in.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { FakeGitHub } from "../../fixtures/github/issues.ts";
import { expectRejection } from "../../fixtures/assertions/rejection.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("the lane tracker serves an external-CLI tracker from the ticket ref with no saved site", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-signed-in-"));
  directories.push(directory);
  const statePath = join(directory, "state.db");
  const github = new FakeGitHub();
  github.add("octo-org/repo", 4);
  const store = new StateStore(statePath);
  try {
    const lane = signedInLaneTracker(
      {
        statePath,
        configuration: { cwd: directory, statePath },
        execution: { github: github.transport },
      },
      store,
    );
    const ticket = issueRef("octo-org/repo", 4);
    await lane.available?.(ticket);
    expect((await lane.read(ticket)).ticket.ref).toBe(ticket);
    await lane.complete?.(ticket);
    expect(github.issues.get("octo-org/repo#4")?.state).toBe("closed");
  } finally {
    store.close();
  }
});

test("the lane tracker reports a signed-out gh as tracker_unavailable before any work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-signed-in-"));
  directories.push(directory);
  const statePath = join(directory, "state.db");
  const signedOut = ghCliTransport({
    run: async () => ({ exitCode: 4, stdout: "", stderr: "not logged in" }),
  });
  const store = new StateStore(statePath);
  try {
    const lane = signedInLaneTracker(
      {
        statePath,
        configuration: { cwd: directory, statePath },
        execution: { github: signedOut },
      },
      store,
    );
    await expectRejection(
      Promise.resolve(lane.available?.(issueRef("octo-org/repo", 4))),
    ).toMatchObject({ code: "tracker_unavailable" });
  } finally {
    store.close();
  }
});
