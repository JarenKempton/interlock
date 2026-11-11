import type { Readable, Writable } from "node:stream";
import {
  type CallToolResult,
  McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ActionTree, type RegisteredAction, registeredActions } from "../app/action.ts";
import { serveAnsweredStdio } from "./stdio.ts";

export interface McpServerOptions {
  version: string;
  allow?: readonly string[];
}

const refusedResult = z.object({
  ok: z.literal(false),
  refusal: z.object({ code: z.string(), message: z.string() }),
});
const refusalCode = /^[a-z]+(?:_[a-z]+)*$/;

export function toolName(command: readonly string[]): string {
  return command.join("_").replaceAll("-", "_");
}

function toolText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function refusalOf(error: unknown): z.infer<typeof refusedResult> | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return;
  if (!refusalCode.test(error.code)) return;
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return { ok: false, refusal: { code: error.code, message } };
}

function advertisedInput(fields: z.ZodRawShape): StandardSchemaWithJSON {
  const { jsonSchema } = z.strictObject(fields)["~standard"];
  return {
    "~standard": { version: 1, vendor: "interlock", validate: (value) => ({ value }), jsonSchema },
  };
}

async function callTool(entry: RegisteredAction, args: unknown): Promise<CallToolResult> {
  try {
    const value = await entry.action.invoke(args);
    return {
      content: [{ type: "text", text: toolText(value) }],
      isError: refusedResult.safeParse(value).success,
    };
  } catch (error) {
    const refusal = refusalOf(error);
    return {
      content: [{ type: "text", text: refusal ? toolText(refusal) : "Tool call failed" }],
      isError: true,
    };
  }
}

export function toolActions(tree: ActionTree, allow?: readonly string[]): RegisteredAction[] {
  const actions = registeredActions(tree).filter((entry) => entry.command.join(" ") !== "mcp");
  if (!allow) return actions;
  if (allow.length === 0) throw new Error("MCP allowlist names no actions");
  const labels = new Set(actions.map((entry) => entry.command.join(" ")));
  if (allow.some((label) => !labels.has(label)))
    throw new Error("MCP allowlist names an unknown action");
  return actions.filter((entry) => allow.includes(entry.command.join(" ")));
}

export function createMcpServer(tree: ActionTree, options: McpServerOptions): McpServer {
  const server = new McpServer({ name: "interlock", version: options.version });
  for (const entry of toolActions(tree, options.allow)) {
    server.registerTool(
      toolName(entry.command),
      { description: entry.action.description, inputSchema: advertisedInput(entry.action.fields) },
      (args) => callTool(entry, args),
    );
  }
  return server;
}

export async function serveMcpStdio(
  tree: ActionTree,
  options: McpServerOptions,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  toolActions(tree, options.allow);
  await serveAnsweredStdio(() => createMcpServer(tree, options), input, output);
}
