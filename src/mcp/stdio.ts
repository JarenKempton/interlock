import { PassThrough, type Readable, type Writable } from "node:stream";
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const streamingMethods = new Set(["subscriptions/listen"]);

function withoutEchoedToolName(message: JSONRPCMessage, toolName: unknown): JSONRPCMessage {
  if (!isJSONRPCErrorResponse(message) || typeof toolName !== "string") return message;
  if (message.error.message !== `Tool ${toolName} not found`) return message;
  return { ...message, error: { ...message.error, message: "Unknown tool" } };
}

export async function serveAnsweredStdio(
  factory: McpServerFactory,
  input: Readable,
  output: Writable,
): Promise<void> {
  const wire = new PassThrough();
  input.pipe(wire, { end: false });
  const transport = new StdioServerTransport(wire, output);
  const handle = serveStdio(factory, { transport });
  const pending = new Map<unknown, unknown>();
  let ended = false;
  const settle = (id?: unknown) => {
    pending.delete(id);
    if (ended && pending.size === 0 && !wire.writableEnded) wire.end();
  };
  const abandon = () => {
    ended = true;
    pending.clear();
    settle();
  };
  const receive = transport.onmessage;
  transport.onmessage = (message) => {
    if (isJSONRPCRequest(message) && !streamingMethods.has(message.method))
      pending.set(message.id, message.method === "tools/call" ? message.params?.name : undefined);
    if (isJSONRPCNotification(message) && message.method === "notifications/cancelled")
      settle(message.params?.requestId);
    receive?.(message);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    const answered = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
    try {
      await send(answered ? withoutEchoedToolName(message, pending.get(message.id)) : message);
    } finally {
      if (answered) settle(message.id);
    }
  };
  const closed = new Promise<void>((resolveClosed) => {
    const close = transport.onclose;
    transport.onclose = () => {
      close?.();
      resolveClosed();
    };
  });
  let inputEnded = false;
  input.once("end", () => {
    inputEnded = true;
    setImmediate(() => {
      ended = true;
      settle();
    });
  });
  input.once("error", abandon);
  input.once("close", () => {
    if (!inputEnded) abandon();
  });
  await closed;
  await handle.close();
}
