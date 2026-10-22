import { describe, expect, test } from "bun:test";
import type { ReclaimRequest, ReleaseClaimRequest } from "../src/domain/contracts.ts";
import { actorRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import { type Claim, claimStatusAt, type TrackerSnapshot } from "../src/domain/model.ts";

const originalSnapshot: TrackerSnapshot = {
  version: "before-claim",
  payload: { assignee: null, status: "To Do", claim: null },
};

const claim: Claim = {
  ref: "interlock-claim:first",
  ticket: ticketRefSchema.parse("jira:x:W:ticket:A"),
  humanOwner: actorRefSchema.parse("jaren"),
  run: "interlock-run:first",
  previousState: originalSnapshot,
  claimedAt: "2026-08-10T12:00:00.000Z",
  leaseExpiresAt: "2026-08-10T12:15:00.000Z",
  status: "active",
};

describe("claim semantics", () => {
  test("lease expiry derives stale status without mutating the claim", () => {
    expect(claimStatusAt(claim, new Date("2026-08-10T12:14:59.999Z"))).toBe("active");
    expect(claimStatusAt(claim, new Date("2026-08-10T12:15:00.000Z"))).toBe("stale");
    expect(claim.status).toBe("active");
    expect(String(claim.humanOwner)).toBe("jaren");
  });

  test("reclaim contract requires authorization, expected state, and original snapshot", () => {
    const request: ReclaimRequest = {
      staleClaim: claim.ref,
      claim: "interlock-claim:second",
      run: "interlock-run:second",
      ticket: claim.ticket,
      owner: actorRefSchema.parse("new-owner"),
      authorizedBy: actorRefSchema.parse("operator"),
      leaseExpiresAt: "2026-08-10T12:30:00.000Z",
      expectedVersion: "stale-version",
      originalSnapshot: claim.previousState,
    };
    expect(String(request.authorizedBy)).toBe("operator");
    expect(request.staleClaim).toBe("interlock-claim:first");
    expect(request.originalSnapshot).toBe(originalSnapshot);
  });

  test("release contract restores the original snapshot under an expected version", () => {
    const request: ReleaseClaimRequest = {
      claim: claim.ref,
      ticket: claim.ticket,
      claimedOwner: claim.humanOwner,
      originalSnapshot: claim.previousState,
      expectedVersion: "claimed-version",
      authorizedBy: actorRefSchema.parse("operator"),
    };
    expect(request.originalSnapshot.payload).toEqual({
      assignee: null,
      status: "To Do",
      claim: null,
    });
  });
});
