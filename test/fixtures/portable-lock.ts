import type { ClaimLockFixture } from "../../src/conformance/claim-lock.ts";
import {
  CLAIM_RECORD_VERSION,
  type ClaimLock,
  type ClaimLockRecord,
  type ClaimLockState,
} from "../../src/domain/claim-lock.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../../src/domain/contracts.ts";
import { actorRefSchema, ticketRefSchema } from "../../src/domain/identifiers.ts";

export function fakeLockFixture(): ClaimLockFixture {
  let state: ClaimLockState = { version: "absent", record: null };
  let writes = 0;
  let failReadback = false;
  let unreadable = false;
  let expired = false;
  function expectVersion(expected: string) {
    if (state.version !== expected) throw new ClaimCollisionError();
  }
  function held(claim: string) {
    if (!state.record || state.record.action === "release" || state.record.claim !== claim)
      throw new ClaimCollisionError();
    return state.record;
  }
  function commit(record: ClaimLockRecord) {
    state = { version: String(++writes), record };
    if (failReadback) unreadable = true;
    if (unreadable) throw new AmbiguousTrackerResultError();
  }
  function adapter(): ClaimLock {
    return {
      async describe() {
        return { conditional_update: true };
      },
      async read() {
        if (unreadable) throw new AmbiguousTrackerResultError();
        return structuredClone(state);
      },
      async claim(request) {
        expectVersion(request.expectedVersion);
        if (state.record && state.record.action !== "release") throw new ClaimCollisionError();
        if (expired) throw new ClaimCollisionError();
        commit({
          action: "claim",
          ticket: request.ticket,
          claim: request.claim,
          run: request.run,
          owner: request.owner,
          leaseExpiresAt: request.leaseExpiresAt,
          home: "fake/home",
          version: CLAIM_RECORD_VERSION,
        });
      },
      async release(request) {
        expectVersion(request.expectedVersion);
        const record = held(request.claim);
        if (record.owner !== request.authorizedBy) throw new ClaimCollisionError();
        commit({ ...record, action: "release", authorizedBy: request.authorizedBy });
      },
    };
  }
  return {
    adapter: adapter(),
    contender: adapter(),
    request: {
      ticket: ticketRefSchema.parse("fake:test:WORK:ticket:T-1"),
      claim: "interlock-claim:conformance",
      run: "interlock-run:conformance",
      owner: actorRefSchema.parse("human"),
      leaseExpiresAt: "2099-01-01T00:15:00.000Z",
      expectedVersion: "absent",
    },
    otherOwner: actorRefSchema.parse("other-human"),
    loseWriteReadback: () => {
      failReadback = true;
    },
    expireLease: () => {
      expired = true;
    },
  };
}
