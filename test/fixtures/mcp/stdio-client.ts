import { PassThrough } from "node:stream";
import { z } from "zod";
import type { ActionTree } from "../../../src/app/action.ts";
import { type McpServerOptions, serveMcpStdio } from "../../../src/mcp/server.ts";

const message = z.looseObject({ id: z.unknown().optional() });
export type McpMessage = z.infer<typeof message>;

export const toolResult = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    isError: z.boolean().optional(),
  }),
});

export function request(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

export const legacyOpening = [
  request(0, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "interlock-test", version: "0.0.0" },
  }),
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

export async function exchange(
  tree: ActionTree,
  messages: unknown[],
  options: McpServerOptions = { version: "test" },
): Promise<McpMessage[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const expected = new Set(
    messages.flatMap((item) => {
      if (typeof item === "string") return [];
      const parsed = message.parse(item);
      return "id" in parsed && "method" in parsed ? [parsed.id] : [];
    }),
  );
  const received: McpMessage[] = [];
  let buffer = "";
  const answered = new Promise<void>((resolveAnswered) => {
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) received.push(message.parse(JSON.parse(line)));
      if (received.filter((item) => expected.has(item.id)).length >= expected.size)
        resolveAnswered();
    });
  });
  const serving = serveMcpStdio(tree, options, input, output);
  for (const item of messages)
    input.write(typeof item === "string" ? `${item}\n` : `${JSON.stringify(item)}\n`);
  await answered;
  input.end();
  await serving;
  return received;
}

export function responseTo(messages: McpMessage[], id: number): McpMessage {
  const found = messages.find((item) => item.id === id);
  if (!found) throw new Error(`No response to request ${id}`);
  return found;
}

export async function callTool(
  tree: ActionTree,
  name: string,
  args: Record<string, unknown>,
): Promise<z.infer<typeof toolResult>["result"]> {
  const messages = await exchange(tree, [
    ...legacyOpening,
    request(1, "tools/call", { name, arguments: args }),
  ]);
  return toolResult.parse(responseTo(messages, 1)).result;
}
