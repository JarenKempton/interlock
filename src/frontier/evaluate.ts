import {
  groupRefSchema,
  mapRefSchema,
  ticketRefSchema,
  workspaceRefSchema,
} from "../domain/identifiers.ts";
import type { GroupRef, MapRef, Ticket, TicketRef, WorkspaceRef } from "../domain/model.ts";
import { parseRef, workspaceRefOf } from "../domain/reference.ts";

export interface FrontierScope {
  workspace?: WorkspaceRef;
  group?: GroupRef;
  map?: MapRef;
  ticket?: TicketRef;
}

export interface FrontierOptions {
  availableStatuses: ReadonlySet<string>;
}

export function evaluateFrontier(
  tickets: readonly Ticket[],
  scope: FrontierScope,
  options: FrontierOptions,
): Ticket[] {
  const normalized = normalizeTrackerTickets(tickets);
  const normalizedScope = normalizeScope(scope);
  validateScope(normalizedScope, normalized.workspace);
  const byRef = new Map<TicketRef, Ticket>(
    normalized.tickets.map((ticket) => [ticket.ref, ticket]),
  );
  const eligible: Ticket[] = [];

  for (const ticket of normalized.tickets) {
    if (!isInScope(ticket, normalizedScope)) continue;
    if (ticket.state !== "open") continue;
    if (!options.availableStatuses.has(ticket.status)) continue;
    if (ticket.assignee !== undefined) continue;

    let blocked = false;
    for (const dependency of ticket.dependencies ?? []) {
      const blocker = byRef.get(dependency.blocking);
      if (!blocker) {
        throw new Error(`Ticket ${ticket.ref} references unknown blocker ${dependency.blocking}`);
      }
      if (blocker.state !== "closed") {
        blocked = true;
        break;
      }
    }
    if (!blocked) eligible.push(ticket);
  }

  // Modern Array#sort is stable. Equal order values therefore retain the tracker
  // adapter's input order instead of inventing a reference-based ordering.
  return eligible.toSorted((left, right) => left.order - right.order);
}

export interface NormalizedTrackerTickets {
  workspace?: WorkspaceRef;
  tickets: Ticket[];
}

/**
 * Validates the normalized tracker boundary before core evaluates policy.
 * V1 intentionally fails closed on partial or cross-workspace dependency graphs.
 */
export function normalizeTrackerTickets(tickets: readonly Ticket[]): NormalizedTrackerTickets {
  const seen = new Set<TicketRef>();
  let workspace: WorkspaceRef | undefined;
  const normalized: Ticket[] = [];

  for (const ticket of tickets) {
    if (!ticket || typeof ticket !== "object") throw new Error("Invalid normalized ticket");
    requireKind(ticket.ref, "ticket");
    requireKind(ticket.map, "map");
    if (ticket.group !== undefined) requireKind(ticket.group, "group");
    if (!["task", "research", "prototype", "decision"].includes(ticket.kind)) {
      throw new Error(`Ticket ${ticket.ref} has an unsupported kind: ${ticket.kind}`);
    }
    if (ticket.state !== "open" && ticket.state !== "closed") {
      throw new Error(`Ticket ${ticket.ref} has an unsupported state: ${ticket.state}`);
    }
    if (typeof ticket.status !== "string" || ticket.status.length === 0) {
      throw new Error(`Ticket ${ticket.ref} has an invalid status`);
    }
    if (!Number.isFinite(ticket.order)) {
      throw new Error(`Ticket ${ticket.ref} has a non-finite tracker order`);
    }
    if (seen.has(ticket.ref)) throw new Error(`Duplicate ticket reference: ${ticket.ref}`);
    seen.add(ticket.ref);

    const ticketWorkspace = workspaceRefSchema.parse(workspaceRefOf(ticket.ref));
    if (workspace === undefined) workspace = ticketWorkspace;
    if (workspace !== ticketWorkspace) {
      throw new Error(`Cross-workspace frontier input is not supported: ${ticket.ref}`);
    }
    requireSameWorkspace(ticket.ref, ticket.map);
    if (ticket.group !== undefined) requireSameWorkspace(ticket.ref, ticket.group);

    for (const dependency of ticket.dependencies ?? []) {
      requireKind(dependency.blocking, "ticket");
      requireKind(dependency.blocked, "ticket");
      if (dependency.kind !== "blocks") {
        throw new Error(`Ticket ${ticket.ref} has an unsupported dependency kind`);
      }
      if (dependency.blocked !== ticket.ref) {
        throw new Error(
          `Ticket ${ticket.ref} contains a dependency owned by ${dependency.blocked}`,
        );
      }
      requireSameWorkspace(ticket.ref, dependency.blocking);
    }
    normalized.push({
      ...ticket,
      ...(ticket.dependencies
        ? { dependencies: ticket.dependencies.map((item) => ({ ...item })) }
        : {}),
    });
  }

  for (const ticket of normalized) {
    for (const dependency of ticket.dependencies ?? []) {
      if (!seen.has(dependency.blocking)) {
        throw new Error(`Ticket ${ticket.ref} references unknown blocker ${dependency.blocking}`);
      }
    }
  }

  return { ...(workspace ? { workspace } : {}), tickets: normalized };
}

export function selectFrontierTicket(tickets: readonly Ticket[], policy: string): Ticket {
  const first = tickets[0];
  if (!first) throw new Error("Frontier is empty");
  if (policy === "first") return first;
  if (policy === "highest-priority") {
    return tickets.reduce((selected, ticket) =>
      (ticket.priority ?? 0) > (selected.priority ?? 0) ? ticket : selected,
    );
  }
  throw new Error(`Unknown or missing noninteractive selection policy: ${JSON.stringify(policy)}`);
}

function isInScope(ticket: Ticket, scope: FrontierScope): boolean {
  if (scope.ticket !== undefined) return ticket.ref === scope.ticket;
  if (scope.map !== undefined) return ticket.map === scope.map;
  if (scope.group !== undefined) return ticket.group === scope.group;
  if (scope.workspace !== undefined) return workspaceRefOf(ticket.ref) === scope.workspace;
  return true;
}

function requireKind(reference: string, expected: "workspace" | "group" | "map" | "ticket"): void {
  const actual = parseRef(reference).kind;
  if (actual !== expected) {
    throw new Error(`Expected ${expected} reference, received ${actual}: ${reference}`);
  }
}

function requireSameWorkspace(owner: string, related: string): void {
  if (workspaceRefOf(owner) !== workspaceRefOf(related)) {
    throw new Error(`Cross-workspace relationship is not supported: ${owner} -> ${related}`);
  }
}

function validateScope(scope: FrontierScope, workspace: WorkspaceRef | undefined): void {
  const references = [scope.workspace, scope.group, scope.map, scope.ticket].filter(
    (item): item is WorkspaceRef | GroupRef | MapRef | TicketRef => item !== undefined,
  );
  if (references.length > 1) throw new Error("Frontier scope must contain at most one reference");
  const reference = references[0];
  if (
    reference !== undefined &&
    workspace !== undefined &&
    workspaceRefOf(reference) !== workspace
  ) {
    throw new Error(`Frontier scope ${reference} is outside workspace ${workspace}`);
  }
}

function normalizeScope(scope: FrontierScope): FrontierScope {
  return {
    ...(scope.workspace === undefined
      ? {}
      : { workspace: workspaceRefSchema.parse(normalizeScopeRef(scope.workspace, "workspace")) }),
    ...(scope.group === undefined
      ? {}
      : { group: groupRefSchema.parse(normalizeScopeRef(scope.group, "group")) }),
    ...(scope.map === undefined
      ? {}
      : { map: mapRefSchema.parse(normalizeScopeRef(scope.map, "map")) }),
    ...(scope.ticket === undefined
      ? {}
      : { ticket: ticketRefSchema.parse(normalizeScopeRef(scope.ticket, "ticket")) }),
  };
}

function normalizeScopeRef(
  reference: string,
  expected: "workspace" | "group" | "map" | "ticket",
): string {
  const parsed = parseRef(reference);
  if (parsed.kind !== expected) {
    throw new Error(`Expected ${expected} scope reference, received ${parsed.kind}: ${parsed.raw}`);
  }
  return parsed.raw;
}
