#!/usr/bin/env bun
import { z } from "zod";

const request = z
  .object({ id: z.string(), method: z.string() })
  .parse(JSON.parse(await Bun.stdin.text()));
const scenario = Bun.env.INTERLOCK_CONFORMANCE_SCENARIO ?? "normal";

if (scenario === "hang") {
  await new Promise(() => {});
} else if (scenario === "crash") {
  process.exit(17);
} else if (scenario === "oversized") {
  respond(request.id, { payload: "x".repeat(1024) });
} else if (scenario === "credential") {
  respond(request.id, {
    handle: Bun.env.INTERLOCK_CREDENTIAL_HANDLE,
    argv: process.argv,
  });
} else if (request.method !== "adapter.initialize") {
  console.log(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" },
    }),
  );
} else {
  respond(request.id, {
    adapter: {
      name: "conformance-fixture",
      version: "0.1.0",
      protocol_versions: [scenario === "incompatible" ? "2.0" : "1.0"],
      capabilities: {},
    },
  });
}

function respond(id: string, result: unknown) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
