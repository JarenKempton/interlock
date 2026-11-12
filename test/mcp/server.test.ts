import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { createApplication, VERSION } from "../../src/app/application.ts";
import { defineAction, registeredActions } from "../../src/app/action.ts";
import { describeAction } from "../../src/cli/catalog.ts";
import { dispatch } from "../../src/cli/command-line.ts";
import { positional, text } from "../../src/cli/schema.ts";
import { HostRefusal } from "../../src/domain/host/capability.ts";
import { serveMcpStdio, toolActions } from "../../src/mcp/server.ts";
import {
  callTool,
  exchange,
  legacyOpening,
  request,
  responseTo,
} from "../fixtures/mcp/stdio-client.ts";
import { expectRejection } from "../fixtures/assertions/rejection.ts";

const secret = "lane-secret-DO-NOT-ECHO";

const toolList = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.object({
          properties: z.record(z.string(), z.unknown()).optional(),
          required: z.array(z.string()).optional(),
        }),
      }),
    ),
  }),
});

const initializeResult = z.object({
  result: z.object({
    protocolVersion: z.string(),
    serverInfo: z.object({ name: z.string(), version: z.string() }),
  }),
});

test("tools/list is generated from the same registered actions as JSON help", async () => {
  const app = createApplication();
  const messages = await exchange(app, [...legacyOpening, request(1, "tools/list")]);
  const tools = toolList.parse(responseTo(messages, 1)).result.tools;
  const described = registeredActions(app)
    .filter((entry) => entry.command.join(" ") !== "mcp")
    .map(describeAction);
  expect(tools.map((tool) => tool.name)).toEqual(
    described.map((entry) => entry.command.join("_").replaceAll("-", "_")),
  );
  for (const [index, entry] of described.entries()) {
    const tool = tools[index];
    expect(tool?.description).toBe(entry.description);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(Object.keys(entry.input));
    const required = Object.entries(entry.input)
      .filter(([, field]) => field.required)
      .map(([name]) => name);
    expect(tool?.inputSchema.required ?? []).toEqual(required);
  }
});

test("a newly registered action becomes a tool without a hand-written list", async () => {
  const tree = {
    sample: defineAction({
      description: "Echo a value.",
      input: { value: positional(text("Value.", "VALUE")) },
      result: z.string(),
      handler: ({ value }) => `got:${value}`,
    }),
  };
  expect(await callTool(tree, "sample", { value: "next" })).toEqual({
    content: [{ type: "text", text: "got:next" }],
    isError: false,
  });
});

test("stdio serves the official SDK handshake and negotiates the protocol version", async () => {
  const opened = await exchange(createApplication(), legacyOpening, { version: VERSION });
  const opening = initializeResult.parse(responseTo(opened, 0)).result;
  expect(opening.serverInfo).toEqual({ name: "interlock", version: VERSION });
  expect(opening.protocolVersion).toBe("2025-06-18");
  const unknown = await exchange(createApplication(), [
    request(0, "initialize", {
      protocolVersion: "1999-01-01",
      capabilities: {},
      clientInfo: { name: "interlock-test", version: "0.0.0" },
    }),
  ]);
  expect(initializeResult.parse(responseTo(unknown, 0)).result.protocolVersion).not.toBe(
    "1999-01-01",
  );
});

test("a thrown refusal returns its refusal code and message", async () => {
  const tree = {
    launch: defineAction({
      description: "Refuse to launch.",
      input: {},
      result: z.string(),
      handler: () => {
        throw new HostRefusal("host_unavailable", "The T3 server is not running");
      },
    }),
  };
  const result = await callTool(tree, "launch", {});
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    ok: false,
    refusal: { code: "host_unavailable", message: "The T3 server is not running" },
  });
});

test("a refused action result is reported as a tool error", async () => {
  const tree = {
    lane: defineAction({
      description: "Return a refusal.",
      input: {},
      result: z.object({
        ok: z.literal(false),
        refusal: z.object({ code: z.string(), message: z.string() }),
      }),
      handler: () => ({
        ok: false as const,
        refusal: { code: "invalid_transition", message: "Lane is not implementing" },
      }),
    }),
  };
  const result = await callTool(tree, "lane", {});
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
    ok: false,
    refusal: { code: "invalid_transition", message: "Lane is not implementing" },
  });
});

test("uncoded failures, unknown tools, and malformed lines never echo input", async () => {
  const failed = await callTool(createApplication(), "runs_show", { run: secret });
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain(secret);
  const messages = await exchange(createApplication(), [
    ...legacyOpening,
    request(1, "tools/call", { name: "nope", arguments: { value: secret } }),
    `{"not json": "${secret}"`,
    request(2, "nope"),
  ]);
  expect(JSON.stringify(responseTo(messages, 1))).not.toContain(secret);
  expect(responseTo(messages, 2)).toMatchObject({ error: { code: -32601 } });
  expect(JSON.stringify(messages)).not.toContain(secret);
});

test("the allowlist exposes only named actions and refuses unknown names", async () => {
  const app = createApplication();
  const messages = await exchange(app, [...legacyOpening, request(1, "tools/list")], {
    version: VERSION,
    allow: ["version", "runs list"],
  });
  const tools = toolList.parse(responseTo(messages, 1)).result.tools;
  expect(tools.map((tool) => tool.name)).toEqual(["runs_list", "version"]);
  expect(() => toolActions(app, ["nope"])).toThrow("MCP allowlist names an unknown action");
  expect(() => toolActions(app, ["mcp"])).toThrow("MCP allowlist names an unknown action");
});

test("system errors with errno codes are not reported as refusals", async () => {
  const tree = {
    open: defineAction({
      description: "Fail like the filesystem.",
      input: {},
      result: z.string(),
      handler: () => {
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${secret}'`), {
          code: "EACCES",
        });
      },
    }),
  };
  expect(await callTool(tree, "open", {})).toEqual({
    content: [{ type: "text", text: "Tool call failed" }],
    isError: true,
  });
});

test("the action parses raw arguments once and unknown keys are never echoed", async () => {
  const tree = {
    measure: defineAction({
      description: "Measure a value.",
      input: {
        value: z
          .string()
          .transform((value) => value.length)
          .pipe(z.number()),
      },
      result: z.number(),
      handler: ({ value }) => value,
    }),
  };
  expect((await callTool(tree, "measure", { value: "abcd" })).content[0]?.text).toBe("4");
  const unknown = await callTool(tree, "measure", { value: "abcd", [secret]: "v" });
  expect(unknown.isError).toBe(true);
  expect(JSON.stringify(unknown)).not.toContain(secret);
});

test("requests still in flight when stdin ends are answered before the server stops", async () => {
  let finish = () => {};
  const tree = {
    slow: defineAction({
      description: "Finish later.",
      input: {},
      result: z.string(),
      handler: () => new Promise<string>((resolveSlow) => (finish = () => resolveSlow("done"))),
    }),
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const serving = serveMcpStdio(tree, { version: VERSION }, input, output);
  for (const item of [...legacyOpening, request(1, "tools/call", { name: "slow", arguments: {} })])
    input.write(`${JSON.stringify(item)}\n`);
  input.end();
  await Bun.sleep(20);
  finish();
  await serving;
  const answered = written
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(answered.find((item) => item.id === 1)).toMatchObject({
    result: { content: [{ type: "text", text: "done" }] },
  });
});

function serving(tree: Parameters<typeof serveMcpStdio>[0]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const stopped = serveMcpStdio(tree, { version: VERSION }, input, output);
  const send = (item: unknown) => input.write(`${JSON.stringify(item)}\n`);
  const lines = () =>
    written
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { input, stopped, send, lines };
}

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "interlock-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

test("an open modern subscription does not keep the server alive after stdin ends", async () => {
  const server = serving(createApplication());
  server.send(request(1, "tools/call", { name: "version", arguments: {}, _meta: modernMeta }));
  server.send(
    request(2, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
      _meta: modernMeta,
    }),
  );
  await Bun.sleep(20);
  server.input.end();
  const outcome = await Promise.race([
    server.stopped.then(() => "stopped"),
    Bun.sleep(1000).then(() => "hung"),
  ]);
  expect(outcome).toBe("stopped");
  expect(server.lines().find((item) => item.id === 1)).toMatchObject({
    result: { content: [{ type: "text" }] },
  });
});

test("a broken or closed stdin stops the server without an uncaught error", async () => {
  for (const stop of [
    (input: PassThrough) => input.destroy(new Error("ECONNRESET")),
    (input: PassThrough) => input.destroy(),
  ]) {
    const server = serving(createApplication());
    server.send(legacyOpening[0]);
    await Bun.sleep(10);
    stop(server.input);
    const outcome = await Promise.race([
      server.stopped.then(() => "stopped"),
      Bun.sleep(1000).then(() => "hung"),
    ]);
    expect(outcome).toBe("stopped");
  }
});

test("an unknown tool name is not echoed back", async () => {
  const messages = await exchange(createApplication(), [
    ...legacyOpening,
    request(1, "tools/call", { name: secret, arguments: {} }),
  ]);
  expect(responseTo(messages, 1)).toMatchObject({
    error: { code: -32602, message: "Unknown tool" },
  });
});

test("an unsupported protocol version is refused without echoing the requested version", async () => {
  const meta = { ...modernMeta, "io.modelcontextprotocol/protocolVersion": secret };
  const messages = await exchange(createApplication(), [
    request(1, "tools/list", { _meta: meta }),
    request(2, "tools/call", { name: "version", arguments: {}, _meta: meta }),
  ]);
  for (const id of [1, 2])
    expect(responseTo(messages, id)).toMatchObject({
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: expect.any(Array) },
      },
    });
  expect(JSON.stringify(messages)).not.toContain(secret);
});

test("an allowlist that names nothing fails closed", async () => {
  expect(() => toolActions(createApplication(), [])).toThrow("MCP allowlist names no actions");
  await expectRejection(dispatch(createApplication(), ["mcp", "--allow", ","], () => {})).toThrow(
    "MCP allowlist names no actions",
  );
});

test("mcp command help offers only the stdio allowlist", async () => {
  const output: string[] = [];
  await dispatch(createApplication(), ["mcp", "--help", "--json"], (line) => output.push(line));
  const help = JSON.parse(output[0] ?? "");
  expect(help.command).toEqual(["mcp"]);
  expect(Object.keys(help.input)).toEqual(["allow"]);
});
