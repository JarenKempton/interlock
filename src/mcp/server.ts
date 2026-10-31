import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { registeredActions } from "../cli/catalog.ts";
import type { ActionTree, ActionView } from "../cli/definition.ts";
import { VERSION } from "../distribution/version.ts";

export interface McpServerOptions {
  lane?: boolean;
  allow?: readonly string[];
  token?: string;
}

export interface McpSession {
  authenticated: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function actionInputSchema(action: ActionView): Record<string, unknown> {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(z.strictObject(action.fields));
  return inputSchema;
}

export function toolName(command: readonly string[]): string {
  return command.join("_").replaceAll("-", "_");
}

export class McpServer {
  readonly tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    command: string[];
    invoke: (input: unknown) => Promise<unknown>;
  }[] = [];
  private readonly lane: boolean;
  private readonly tokenDigest: Buffer | undefined;

  constructor(tree: ActionTree, options: McpServerOptions = {}) {
    this.lane = options.lane === true;
    if (this.lane) {
      if (!options.token) throw new Error("Lane mode requires a per-lane token");
      if (!options.allow?.length) throw new Error("Lane mode requires an action allowlist");
    }
    this.tokenDigest = options.token
      ? createHash("sha256").update(options.token).digest()
      : undefined;
    const allowed = options.allow?.map((entry) => entry.trim()).filter(Boolean);
    const known = new Set<string>();
    for (const entry of registeredActions(tree)) {
      const label = entry.command.join(" ");
      if (label === "mcp") continue;
      known.add(label);
      if (allowed && !allowed.includes(label)) continue;
      this.tools.push({
        name: toolName(entry.command),
        description: entry.action.description,
        inputSchema: actionInputSchema(entry.action),
        command: entry.command,
        invoke: (input) => entry.action.invoke(input),
      });
    }
    if (allowed) {
      for (const label of allowed) {
        if (!known.has(label)) throw new Error("Lane allowlist names an unknown action");
      }
      if (this.lane && this.tools.length === 0) throw new Error("Lane mode exposes no actions");
    }
  }

  newSession(authenticated = false): McpSession {
    return { authenticated: authenticated || !this.lane };
  }

  stdioSession(): McpSession {
    return { authenticated: true };
  }

  private acceptsToken(candidate: unknown): boolean {
    if (!this.tokenDigest || typeof candidate !== "string" || candidate.length === 0) return false;
    return timingSafeEqual(createHash("sha256").update(candidate).digest(), this.tokenDigest);
  }

  async handle(raw: unknown, session: McpSession): Promise<Record<string, unknown> | undefined> {
    const request = record(raw);
    const hasId = "id" in request;
    const id = hasId ? (request.id ?? null) : undefined;
    const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): Record<string, unknown> => ({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    });
    if (typeof request.method !== "string")
      return hasId ? fail(-32600, "Invalid request") : undefined;
    if (request.method === "interlock/auth") {
      if (!hasId) return undefined;
      const params = record(request.params);
      if (!this.acceptsToken(params.token)) return fail(-32001, "Authentication failed");
      session.authenticated = true;
      return respond({ ok: true });
    }
    if (!session.authenticated && request.method !== "ping")
      return hasId ? fail(-32001, "Authentication required") : undefined;
    switch (request.method) {
      case "initialize": {
        const params = record(request.params);
        return respond({
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "interlock", version: VERSION },
        });
      }
      case "ping":
        return hasId ? respond({}) : undefined;
      case "tools/list":
        return respond({
          tools: this.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case "tools/call": {
        if (!hasId) return undefined;
        const params = record(request.params);
        const tool = this.tools.find((entry) => entry.name === params.name);
        if (!tool) return fail(-32602, "Unknown tool");
        try {
          const value = await tool.invoke(params.arguments ?? {});
          const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          return respond({ content: [{ type: "text", text }], isError: false });
        } catch {
          return respond({
            content: [{ type: "text", text: "Tool call failed" }],
            isError: true,
          });
        }
      }
      default:
        if (request.method.startsWith("notifications/")) return undefined;
        return hasId ? fail(-32601, "Method not found") : undefined;
    }
  }

  async handleLine(line: string, session: McpSession): Promise<string | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const response = await this.handle(parsed, session);
    return response ? JSON.stringify(response) : undefined;
  }
}
