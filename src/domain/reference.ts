export type RefKind = "tracker" | "workspace" | "group" | "map" | "ticket" | "run" | "claim";

export interface ParsedRef {
  kind: RefKind;
  adapter?: string;
  instance?: string;
  workspace?: string;
  nativeId?: string;
  raw: string;
}

export type WorkspaceEntityKind = "workspace" | "group" | "map" | "ticket";

export function parseRef(input: string): ParsedRef {
  const raw = input.trim();
  if (raw.startsWith("interlock-run:")) {
    return terminalRef(raw, "interlock-run:", "run");
  }
  if (raw.startsWith("interlock-claim:")) {
    return terminalRef(raw, "interlock-claim:", "claim");
  }
  if (raw.startsWith("nav-run:") || raw.startsWith("nav-claim:")) {
    throw new Error("Pre-release nav run and claim references are no longer supported");
  }

  const parts = raw.split(":");
  const [adapter, instance, workspace, kind, nativeId] = parts;
  if (!adapter || !instance) {
    throw new Error(`Invalid qualified reference: ${JSON.stringify(raw)}`);
  }
  if (parts.length === 2) {
    return { kind: "tracker", adapter, instance, raw };
  }
  if (!workspace) {
    throw new Error("Workspace id is empty");
  }
  if (parts.length === 3) {
    return { kind: "workspace", adapter, instance, workspace, raw };
  }
  if (parts.length !== 5 || !nativeId) {
    throw new Error("Reference must end in group, map, or ticket plus a native id");
  }
  if (kind !== "group" && kind !== "map" && kind !== "ticket") {
    throw new Error(`Unknown reference kind: ${JSON.stringify(kind)}`);
  }
  return { kind, adapter, instance, workspace, nativeId, raw };
}

/** Returns the qualified workspace boundary for a workspace-owned reference. */
export function workspaceRefOf(input: string): string {
  const parsed = parseRef(input);
  if (!isWorkspaceEntity(parsed.kind)) {
    throw new Error(`${input} is not owned by a workspace`);
  }
  return `${parsed.adapter}:${parsed.instance}:${parsed.workspace}`;
}

export function isWorkspaceEntity(kind: RefKind): kind is WorkspaceEntityKind {
  return kind === "workspace" || kind === "group" || kind === "map" || kind === "ticket";
}

function terminalRef(raw: string, prefix: string, kind: "run" | "claim"): ParsedRef {
  const nativeId = raw.slice(prefix.length);
  if (!nativeId) {
    throw new Error(`${kind} reference is missing an id`);
  }
  return { kind, nativeId, raw };
}
