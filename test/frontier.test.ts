import { describe, expect, test } from "bun:test";
import {
  actorRefSchema,
  groupRefSchema,
  mapRefSchema,
  ticketRefSchema,
  workspaceRefSchema,
} from "../src/domain/identifiers.ts";
import type { Ticket } from "../src/domain/model.ts";
import { parseTickets } from "../src/domain/tickets.ts";
import {
  evaluateFrontier,
  normalizeTrackerTickets,
  selectFrontierTicket,
} from "../src/frontier/evaluate.ts";

const ref = (value: string) => ticketRefSchema.parse(value);
const base = (value: string, order: number): Ticket => ({
  ref: ref(value),
  map: mapRefSchema.parse("jira:x:W:map:M1"),
  kind: "task",
  state: "open",
  status: "To Do",
  order,
});

describe("frontier", () => {
  test("supports cross-map blockers and stable ordering", () => {
    const a = base("jira:x:W:ticket:A", 2);
    const b = { ...base("jira:x:W:ticket:B", 1), map: mapRefSchema.parse("jira:x:W:map:M2") };
    b.dependencies = [{ blocking: a.ref, blocked: b.ref, kind: "blocks" }];
    const c = base("jira:x:W:ticket:C", 0);
    expect(
      evaluateFrontier([a, b, c], {}, { availableStatuses: new Set(["To Do"]) }).map(
        (item) => item.ref,
      ),
    ).toEqual([c.ref, a.ref]);
  });

  test("preserves tracker input order when order values tie", () => {
    const z = base("jira:x:W:ticket:Z", 1);
    const a = base("jira:x:W:ticket:A", 1);
    expect(
      evaluateFrontier([z, a], {}, { availableStatuses: new Set(["To Do"]) }).map(
        (item) => item.ref,
      ),
    ).toEqual([z.ref, a.ref]);
  });

  test("honors qualified workspace, group, map, and ticket scopes", () => {
    const a = {
      ...base("jira:x:W:ticket:A", 0),
      group: groupRefSchema.parse("jira:x:W:group:G1"),
    };
    const b = {
      ...base("jira:x:W:ticket:B", 1),
      map: mapRefSchema.parse("jira:x:W:map:M2"),
      group: groupRefSchema.parse("jira:x:W:group:G2"),
    };
    const options = { availableStatuses: new Set(["To Do"]) };
    expect(
      evaluateFrontier([a, b], { workspace: workspaceRefSchema.parse("jira:x:W") }, options),
    ).toHaveLength(2);
    expect(evaluateFrontier([a, b], { group: a.group }, options)).toEqual([a]);
    expect(evaluateFrontier([a, b], { map: b.map }, options)).toEqual([b]);
    expect(evaluateFrontier([a, b], { ticket: a.ref }, options)).toEqual([a]);
  });

  test("closed blockers unblock and assignees exclude", () => {
    const a = { ...base("jira:x:W:ticket:A", 0), state: "closed" as const, status: "Done" };
    const b = base("jira:x:W:ticket:B", 1);
    b.dependencies = [{ blocking: a.ref, blocked: b.ref, kind: "blocks" }];
    const c = {
      ...base("jira:x:W:ticket:C", 2),
      assignee: actorRefSchema.parse("human"),
    };
    expect(evaluateFrontier([a, b, c], {}, { availableStatuses: new Set(["To Do"]) })).toEqual([b]);
  });

  test("unknown blockers fail closed", () => {
    const ticket = base("jira:x:W:ticket:B", 0);
    ticket.dependencies = [
      { blocking: ref("jira:x:W:ticket:A"), blocked: ticket.ref, kind: "blocks" },
    ];
    expect(() => evaluateFrontier([ticket], {}, { availableStatuses: new Set(["To Do"]) })).toThrow(
      "unknown blocker",
    );
  });

  test("normalization rejects partial dependency graphs before scope filtering", () => {
    const assigned = {
      ...base("jira:x:W:ticket:B", 0),
      assignee: actorRefSchema.parse("human"),
    };
    assigned.dependencies = [
      { blocking: ref("jira:x:W:ticket:A"), blocked: assigned.ref, kind: "blocks" },
    ];
    expect(() =>
      evaluateFrontier(
        [assigned],
        { map: assigned.map },
        { availableStatuses: new Set(["To Do"]) },
      ),
    ).toThrow("unknown blocker");
  });

  test("rejects cross-workspace and malformed tracker inputs", () => {
    const a = base("jira:x:W:ticket:A", 0);
    const other = {
      ...base("jira:x:OTHER:ticket:B", 1),
      map: mapRefSchema.parse("jira:x:OTHER:map:M2"),
    };
    expect(() => normalizeTrackerTickets([a, other])).toThrow("Cross-workspace frontier");

    const malformed = base("jira:x:W:ticket:B", 1);
    malformed.dependencies = [{ blocking: a.ref, blocked: a.ref, kind: "blocks" }];
    expect(() => normalizeTrackerTickets([a, malformed])).toThrow("dependency owned by");

    expect(() => normalizeTrackerTickets([a, { ...a }])).toThrow("Duplicate ticket");

    expect(() =>
      Reflect.apply(normalizeTrackerTickets, undefined, [[{ ...a, state: "Open" }]]),
    ).toThrow("unsupported state");
    expect(() =>
      Reflect.apply(normalizeTrackerTickets, undefined, [[{ ...a, kind: "bug" }]]),
    ).toThrow("unsupported kind");
    expect(() => normalizeTrackerTickets([{ ...a, status: "" }])).toThrow("invalid status");
    expect(() => normalizeTrackerTickets([{ ...a, order: Number.NaN }])).toThrow(
      "non-finite tracker order",
    );
    expect(() =>
      Reflect.apply(normalizeTrackerTickets, undefined, [[{ ...a, map: "jira:x:W:ticket:M" }]]),
    ).toThrow("Expected map reference");
    expect(() =>
      normalizeTrackerTickets([{ ...a, map: mapRefSchema.parse("jira:x:OTHER:map:M") }]),
    ).toThrow("Cross-workspace relationship");
    const related = base("jira:x:W:ticket:C", 2);
    expect(() =>
      Reflect.apply(normalizeTrackerTickets, undefined, [
        [
          a,
          {
            ...related,
            dependencies: [{ blocking: a.ref, blocked: related.ref, kind: "relates" }],
          },
        ],
      ]),
    ).toThrow("unsupported dependency kind");
    expect(() =>
      evaluateFrontier(
        [a],
        { map: mapRefSchema.parse("jira:x:OTHER:map:M") },
        { availableStatuses: new Set(["To Do"]) },
      ),
    ).toThrow("outside workspace");
  });

  test("ticket input parsing fails closed on malformed tickets", () => {
    const ticket = base("jira:x:W:ticket:A", 0);
    expect(parseTickets([ticket])).toEqual([ticket]);
    expect(() => parseTickets([{ ...ticket, order: "first" }])).toThrow("Invalid ticket input");
    expect(() => parseTickets({ tickets: [ticket] })).toThrow("Invalid ticket input");
  });

  test("canonicalizes parseable scope references", () => {
    const ticket = base("jira:x:W:ticket:A", 0);
    const options = { availableStatuses: new Set(["To Do"]) };
    expect(
      evaluateFrontier([ticket], { workspace: workspaceRefSchema.parse(" jira:x:W ") }, options),
    ).toEqual([ticket]);
    expect(
      evaluateFrontier([ticket], { map: mapRefSchema.parse(` ${ticket.map} `) }, options),
    ).toEqual([ticket]);
  });

  test.each([
    ["workspace", { workspace: "jira:x:W:map:M1" }],
    ["group", { group: "jira:x:W:ticket:A" }],
    ["map", { map: "jira:x:W" }],
    ["ticket", { ticket: "jira:x:W:group:G1" }],
  ] as const)("rejects the wrong qualified kind for %s scope", (kind, scope) => {
    const ticket = base("jira:x:W:ticket:A", 0);
    expect(() =>
      Reflect.apply(evaluateFrontier, undefined, [
        [ticket],
        scope,
        {
          availableStatuses: new Set(["To Do"]),
        },
      ]),
    ).toThrow(`Expected ${kind} scope reference`);
  });

  test("noninteractive selection requires a policy", () => {
    const tickets = [
      { ...base("a", 0), priority: 1 },
      { ...base("b", 1), priority: 5 },
    ];
    expect(() => selectFrontierTicket(tickets, "")).toThrow();
    expect(selectFrontierTicket(tickets, "highest-priority").ref).toBe(ref("b"));
  });
});
