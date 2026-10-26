import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApplication } from "../src/application.ts";
import { describeAction, registeredActions } from "../src/cli/catalog.ts";
import { dispatch } from "../src/cli/command-line.ts";
import { defineAction } from "../src/cli/definition.ts";
import { positional, text } from "../src/cli/schema.ts";
import { McpServer } from "../src/mcp/server.ts";
import { SocketTransport, StdioTransport } from "../src/mcp/transport.ts";

const token = "lane-secret-DO-NOT-ECHO";

const toolList = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});

function request(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

test("tools are generated from the same registered actions as JSON help", () => {
  const app = createApplication();
  const server = new McpServer(app);
  const described = registeredActions(app)
    .filter((entry) => entry.command.join(" ") !== "mcp")
    .map(describeAction);
  expect(server.tools.map((tool) => tool.name)).toEqual(
    described.map((entry) => entry.command.join("_").replaceAll("-", "_")),
  );
  for (const [index, entry] of described.entries()) {
    const tool = server.tools[index];
    expect(tool?.description).toBe(entry.description);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(Object.keys(entry.input));
    const required = Object.entries(entry.input)
      .filter(([, field]) => field.required)
      .map(([name]) => name);
    expect(tool?.inputSchema.required ?? []).toEqual(required);
  }
  expect(server.tools.some((tool) => tool.name === "mcp")).toBe(false);
});

test("a newly registered action becomes a tool without a hand-written list", async () => {
  const tree = {
    sample: defineAction({
      description: "Echo a value.",
      input: { value: positional(text("Value.", "VALUE")) },
      handler: ({ value }) => `got:${value}`,
    }),
  };
  const server = new McpServer(tree);
  expect(server.tools.map((tool) => tool.name)).toEqual(["sample"]);
  const session = server.newSession();
  const call = await server.handle(
    request(1, "tools/call", { name: "sample", arguments: { value: "next" } }),
    session,
  );
  expect(call).toMatchObject({
    result: { content: [{ type: "text", text: "got:next" }], isError: false },
  });
});

test("lane mode fails closed without token, allowlist, or a known action", () => {
  const app = createApplication();
  expect(() => new McpServer(app, { lane: true, allow: ["version"] })).toThrow(
    "Lane mode requires a per-lane token",
  );
  expect(() => new McpServer(app, { lane: true, token })).toThrow(
    "Lane mode requires an action allowlist",
  );
  expect(() => new McpServer(app, { lane: true, token, allow: ["nope"] })).toThrow(
    "Lane allowlist names an unknown action",
  );
  expect(() => new McpServer(app, { lane: true, token, allow: ["mcp"] })).toThrow(
    "Lane allowlist names an unknown action",
  );
});

test("lane socket sessions require the per-lane token and expose only lane actions", async () => {
  const server = new McpServer(createApplication(), {
    lane: true,
    token,
    allow: ["version", "runs list"],
  });
  const session = server.newSession();
  const denied = await server.handle(request(1, "tools/list"), session);
  expect(denied).toMatchObject({ error: { code: -32001, message: "Authentication required" } });
  const wrong = await server.handle(
    request(2, "interlock/auth", { token: "wrong-DO-NOT-ECHO" }),
    session,
  );
  expect(wrong).toMatchObject({ error: { code: -32001, message: "Authentication failed" } });
  expect(JSON.stringify(wrong)).not.toContain("wrong-DO-NOT-ECHO");
  expect(JSON.stringify(wrong)).not.toContain(token);
  const stillDenied = await server.handle(request(3, "tools/list"), session);
  expect(stillDenied).toMatchObject({ error: { code: -32001 } });
  const accepted = await server.handle(request(4, "interlock/auth", { token }), session);
  expect(accepted).toMatchObject({ result: { ok: true } });
  expect(JSON.stringify(accepted)).not.toContain(token);
  const listed = await server.handle(request(5, "tools/list"), session);
  const tools = toolList.parse(listed).result.tools;
  expect(tools.map((tool) => tool.name)).toEqual(["runs_list", "version"]);
  const blocked = await server.handle(
    request(6, "tools/call", { name: "doctor", arguments: {} }),
    session,
  );
  expect(blocked).toMatchObject({ error: { code: -32602, message: "Unknown tool" } });
});

test("lane stdio sessions are authenticated by the launching environment", async () => {
  const server = new McpServer(createApplication(), {
    lane: true,
    token,
    allow: ["version"],
  });
  const listed = await server.handle(request(1, "tools/list"), server.stdioSession());
  const tools = toolList.parse(listed).result.tools;
  expect(tools.map((tool) => tool.name)).toEqual(["version"]);
});

test("tool failures, unknown methods, and malformed lines never echo input", async () => {
  const server = new McpServer(createApplication());
  const session = server.newSession();
  const failed = await server.handle(
    request(1, "tools/call", { name: "runs_show", arguments: { run: token } }),
    session,
  );
  expect(failed).toMatchObject({ result: { isError: true } });
  expect(JSON.stringify(failed)).not.toContain(token);
  expect(await server.handle(request(2, "nope"), session)).toMatchObject({
    error: { code: -32601 },
  });
  expect(
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, session),
  ).toBe(undefined);
  const malformed = await server.handleLine("{not json", session);
  expect(JSON.parse(malformed ?? "")).toMatchObject({ error: { code: -32700 } });
});

async function fakeStdin(lines: string[]) {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const line of lines) yield encoder.encode(`${line}\n`);
  })();
}

test("stdio transport serves initialize, tools/list, and tools/call", async () => {
  const server = new McpServer(createApplication());
  const writes: string[] = [];
  const transport = new StdioTransport(
    await fakeStdin([
      JSON.stringify(request(1, "initialize", { protocolVersion: "2024-11-05" })),
      JSON.stringify(request(2, "tools/list")),
      JSON.stringify(request(3, "tools/call", { name: "version", arguments: {} })),
    ]),
    (text) => writes.push(text),
  );
  await transport.serve(server);
  const messages = writes
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(messages[0].result.serverInfo.name).toBe("interlock");
  expect(messages[1].result.tools.some((tool: { name: string }) => tool.name === "runs_list")).toBe(
    true,
  );
  expect(messages[2].result.content[0].text).toContain("0.1.0");
  expect(writes.join("")).not.toContain(token);
});

test("socket transport serves an authenticated lane session and cleans up", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "interlock-mcp-")), "lane.sock");
  const server = new McpServer(createApplication(), {
    lane: true,
    token,
    allow: ["version"],
  });
  const transport = new SocketTransport(path);
  const serving = transport.serve(server);
  for (let attempt = 0; attempt < 50 && !existsSync(path); attempt++) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
  const socket = createConnection(path);
  const chunks: string[] = [];
  socket.on("data", (chunk) => chunks.push(chunk.toString()));
  const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
  await new Promise<void>((resolvePromise) => socket.once("connect", resolvePromise));
  send(request(1, "tools/list"));
  send(request(2, "interlock/auth", { token }));
  send(request(3, "tools/list"));
  send(request(4, "tools/call", { name: "version", arguments: {} }));
  for (let attempt = 0; attempt < 100 && chunks.join("").trim().split("\n").length < 4; attempt++)
    await Bun.sleep(10);
  const messages = chunks
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(messages[0]).toMatchObject({ error: { code: -32001 } });
  expect(messages[1]).toMatchObject({ result: { ok: true } });
  expect(messages[2].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["version"]);
  expect(messages[3].result.content[0].text).toContain("0.1.0");
  expect(chunks.join("")).not.toContain(token);
  socket.destroy();
  await transport.close();
  await serving;
  expect(existsSync(path)).toBe(false);
});

test("socket transport refuses an occupied path", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "interlock-mcp-")), "lane.sock");
  const first = new SocketTransport(path);
  const serving = first.serve(new McpServer(createApplication()));
  for (let attempt = 0; attempt < 50 && !existsSync(path); attempt++) await Bun.sleep(10);
  await expect(new SocketTransport(path).serve(new McpServer(createApplication()))).rejects.toThrow(
    "MCP socket path already exists",
  );
  await first.close();
  await serving;
});

test("mcp command help derives from its registered action and validates transport", async () => {
  const output: string[] = [];
  await dispatch(createApplication(), ["mcp", "--help", "--json"], (line) => output.push(line));
  const help = JSON.parse(output[0] ?? "");
  expect(help.command).toEqual(["mcp"]);
  expect(Object.keys(help.input)).toEqual(["transport", "socket", "lane", "allow"]);
  await expect(
    dispatch(createApplication(), ["mcp", "--socket", "/tmp/unused.sock"], () => {}),
  ).rejects.toThrow("Socket path requires the socket transport");
});
