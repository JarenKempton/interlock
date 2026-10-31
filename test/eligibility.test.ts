import { describe, expect, test } from "bun:test";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { MapRef, Ticket, TicketRef } from "../src/domain/model.ts";
import type { TrackerRead, TrackerReader } from "../src/domain/tracker.ts";
import { pickupEligibility, unblockedBy } from "../src/execution/eligibility.ts";

const mapped = mapRefSchema.parse("jira:example:TEST:map:TEST-1");
const unmapped = mapRefSchema.parse("jira:example:TEST:map:TEST-2");
const statuses = (map: MapRef) => (map === mapped ? ["To Do"] : undefined);
const ref = (key: string) => ticketRefSchema.parse(`jira:example:TEST:ticket:${key}`);

function ticket(key: string, options: Partial<Ticket> = {}): Ticket {
  return {
    ref: ref(key),
    map: mapped,
    kind: "task",
    state: "open",
    status: "To Do",
    order: 0,
    ...options,
  };
}

function blocks(blocking: string, blocked: string) {
  return { blocking: ref(blocking), blocked: ref(blocked), kind: "blocks" as const };
}

class FakeReader implements TrackerReader {
  readonly reads: TicketRef[] = [];
  readonly failing = new Set<TicketRef>();
  constructor(readonly tickets: Ticket[]) {}

  async list_work(): Promise<Ticket[]> {
    throw new Error("Eligibility must not list maps");
  }

  async read(target: TicketRef): Promise<TrackerRead> {
    this.reads.push(target);
    if (this.failing.has(target)) throw new Error(`read failed: ${target}`);
    const found = this.tickets.find((item) => item.ref === target);
    if (!found) throw new Error(`missing ${target}`);
    return { ticket: found, snapshot: { version: "1", payload: null } };
  }
}

describe("pickup eligibility", () => {
  test("open, unassigned, available, in a configured map, with closed blockers is eligible", async () => {
    const reader = new FakeReader([ticket("TEST-9", { state: "closed", status: "Done" })]);
    const candidate = ticket("TEST-10", { dependencies: [blocks("TEST-9", "TEST-10")] });
    expect(await pickupEligibility(reader, candidate, statuses)).toBe("eligible");
  });

  test.each([
    ["outside map", { map: unmapped }],
    ["assigned", { assignee: actorRefSchema.parse("someone") }],
    ["wrong status", { status: "In Review" }],
    ["closed", { state: "closed" as const }],
  ])("%s is unavailable without reading blockers", async (_name, options) => {
    const reader = new FakeReader([]);
    const candidate = ticket("TEST-10", {
      ...options,
      dependencies: [blocks("TEST-9", "TEST-10")],
    });
    expect(await pickupEligibility(reader, candidate, statuses)).toBe("unavailable");
    expect(reader.reads).toEqual([]);
  });

  test("an open blocker blocks", async () => {
    const reader = new FakeReader([ticket("TEST-9")]);
    const candidate = ticket("TEST-10", { dependencies: [blocks("TEST-9", "TEST-10")] });
    expect(await pickupEligibility(reader, candidate, statuses)).toBe("blocked");
  });
});

describe("unblockedBy", () => {
  const done = ticket("TEST-5", {
    state: "closed",
    status: "Done",
    dependents: [
      blocks("TEST-5", "TEST-10"),
      blocks("TEST-5", "TEST-11"),
      blocks("TEST-5", "TEST-12"),
      blocks("TEST-5", "TEST-13"),
      blocks("TEST-5", "TEST-14"),
      blocks("TEST-5", "TEST-10"),
    ],
  });
  const tickets = () => [
    done,
    ticket("TEST-6"),
    ticket("TEST-7", { state: "closed", status: "Done" }),
    ticket("TEST-10", { dependencies: [blocks("TEST-5", "TEST-10"), blocks("TEST-7", "TEST-10")] }),
    ticket("TEST-11", { dependencies: [blocks("TEST-5", "TEST-11"), blocks("TEST-6", "TEST-11")] }),
    ticket("TEST-12", { map: unmapped, dependencies: [blocks("TEST-5", "TEST-12")] }),
    ticket("TEST-13", {
      assignee: actorRefSchema.parse("someone"),
      dependencies: [blocks("TEST-5", "TEST-13")],
    }),
    ticket("TEST-14", { status: "In Review", dependencies: [blocks("TEST-5", "TEST-14")] }),
  ];

  test("lists only dependents whose every blocker is closed and that pickup would accept", async () => {
    expect(await unblockedBy(new FakeReader(tickets()), done, statuses)).toEqual([ref("TEST-10")]);
  });

  test("lists every dependent once all of its blockers are closed", async () => {
    const reader = new FakeReader(
      tickets().map((item) =>
        item.ref === ref("TEST-6") ? { ...item, state: "closed", status: "Done" } : item,
      ),
    );
    expect(await unblockedBy(reader, done, statuses)).toEqual([ref("TEST-10"), ref("TEST-11")]);
  });

  test("a ticket that blocks nothing unblocks nothing without reading", async () => {
    const reader = new FakeReader([]);
    expect(await unblockedBy(reader, ticket("TEST-5", { state: "closed" }), statuses)).toEqual([]);
    expect(reader.reads).toEqual([]);
  });

  test.each(["TEST-11", "TEST-6"])(
    "a failed read of %s rejects rather than reporting empty",
    async (key) => {
      const reader = new FakeReader(tickets());
      reader.failing.add(ref(key));
      await expect(unblockedBy(reader, done, statuses)).rejects.toThrow("read failed");
    },
  );
});
