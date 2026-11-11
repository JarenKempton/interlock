import { PassThrough, type Readable, type Writable } from "node:stream";
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export async function serveAnsweredStdio(
  factory: McpServerFactory,
  input: Readable,
  output: Writable,
): Promise<void> {
  const wire = new PassThrough();
  input.pipe(wire, { end: false });
  const transport = new StdioServerTransport(wire, output);
  const handle = serveStdio(factory, { transport });
  const pending = new Set<unknown>();
  let ended = false;
  const settle = (id?: unknown) => {
    pending.delete(id);
    if (ended && pending.size === 0) wire.end();
  };
  const receive = transport.onmessage;
  transport.onmessage = (message) => {
    if (isJSONRPCRequest(message)) pending.add(message.id);
    if (isJSONRPCNotification(message) && message.method === "notifications/cancelled")
      settle(message.params?.requestId);
    receive?.(message);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    try {
      await send(message);
    } finally {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) settle(message.id);
    }
  };
  const closed = new Promise<void>((resolveClosed) => {
    const close = transport.onclose;
    transport.onclose = () => {
      close?.();
      resolveClosed();
    };
  });
  input.once("end", () =>
    setImmediate(() => {
      ended = true;
      settle();
    }),
  );
  await closed;
  await handle.close();
}
