import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectT3, type T3Platform } from "../src/adapters/session-hosts/t3/connection.ts";

function fixture() {
  const commands: string[][] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let origin = "http://127.0.0.1:3773";
  let authExit = 0;
  let revokeExit = 0;
  let httpStatus = 200;
  let serverVersion = "0.0.41-nightly.20260909.1426";
  const platform: T3Platform = {
    async readText() {
      return JSON.stringify({
        version: 1,
        origin,
        pid: 42,
        port: 3773,
        startedAt: "2026-09-10T00:00:00Z",
      });
    },
    async run(argv) {
      commands.push([...argv]);
      return argv.includes("issue")
        ? {
            exitCode: authExit,
            stdout: JSON.stringify({
              sessionId: "credential-id",
              token: "secret-token",
              method: "bearer-access-token",
            }),
          }
        : { exitCode: revokeExit, stdout: "private stderr" };
    },
    async fetch(url, init) {
      requests.push({ url, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify(
          url.includes(".well-known")
            ? { environmentId: "env", serverVersion }
            : { snapshotSequence: 1, projects: [], threads: [], updatedAt: "2026-09-10T00:00:00Z" },
        ),
        { status: httpStatus },
      );
    },
  };
  return {
    platform,
    commands,
    requests,
    origin: (value: string) => {
      origin = value;
    },
    failAuth: () => {
      authExit = 1;
    },
    failRevoke: () => {
      revokeExit = 1;
    },
    status: (value: number) => {
      httpStatus = value;
    },
    version: (value: string) => {
      serverVersion = value;
    },
  };
}

test("auth is memory-only, all HTTP disallows redirects, revocation is explicit", async () => {
  const f = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
  await c.request("GET", "/api/orchestration/snapshot");
  await c.close();
  expect(JSON.stringify(f.commands)).not.toContain("secret-token");
  expect(f.commands[0]).toEqual([
    "t3",
    "auth",
    "session",
    "issue",
    "--json",
    "--ttl",
    "2m",
    "--label",
    "interlock",
    "--subject",
    "interlock",
    "--base-dir",
    "/fixture/.t3",
  ]);
  expect(f.commands[1]).toEqual([
    "t3",
    "auth",
    "session",
    "revoke",
    "credential-id",
    "--base-dir",
    "/fixture/.t3",
  ]);
  expect(f.requests.every((r) => r.init?.redirect === "error")).toBe(true);
  expect(f.requests[1]?.init?.headers).toEqual({
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  });
});

test.each([
  "https://example.com",
  "https://127.0.0.1:3773",
  "http://127.0.0.1:3773/path",
  "http://127.0.0.1:3773/?query=1",
  "http://127.0.0.1:3773/#fragment",
  "http://user:pass@127.0.0.1:3773",
  "http://localhost.evil:3773",
])("rejects unsafe discovery origin %s before auth", async (origin) => {
  const f = fixture();
  f.origin(origin);
  await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow();
  expect(f.commands).toHaveLength(0);
  expect(f.requests).toHaveLength(0);
});

test("IPv6 loopback is a supported bare origin", async () => {
  const f = fixture();
  f.origin("http://[::1]:3773");
  const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
  expect(c.runtime.origin).toBe("http://[::1]:3773");
  await c.close();
});

test.each(["EACCES", "invalid-json", "invalid-format"])(
  "discovery failure %s does not silently switch environments",
  async (failure) => {
    const f = fixture();
    const files: string[] = [];
    f.platform.readText = async (path) => {
      files.push(path);
      if (failure === "EACCES")
        throw Object.assign(new Error("private file error"), { code: "EACCES" });
      if (failure === "invalid-json") return "private invalid json";
      return JSON.stringify({ version: 2, origin: "http://127.0.0.1:3773" });
    };
    await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow(
      failure === "EACCES" ? "discovery_unavailable" : "invalid_discovery",
    );
    expect(files).toHaveLength(1);
    expect(f.requests).toHaveLength(0);
    expect(f.commands).toHaveLength(0);
  },
);

test.each([true, false])(
  "absent primary discovery tries dev but never authenticates there (%s)",
  async (devExists) => {
    const f = fixture();
    const readText = f.platform.readText;
    const files: string[] = [];
    f.platform.readText = async (path) => {
      files.push(path);
      if (devExists && path === join("/fixture/.t3", "dev", "server-runtime.json"))
        return readText(path);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow(
      devExists ? "dev_auth_unqualified" : "server_unavailable",
    );
    expect(files).toHaveLength(2);
    expect(f.commands).toHaveLength(0);
  },
);

test("malformed issued credential with a known ID is revoked", async () => {
  const f = fixture();
  const run = f.platform.run;
  f.platform.run = async (argv) => {
    if (!argv.includes("issue")) return run(argv);
    const issued = await run(argv);
    return {
      ...issued,
      stdout: JSON.stringify({
        sessionId: "credential-id",
        token: "secret-token",
        method: "unsupported",
      }),
    };
  };
  await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow(
    "auth_unavailable",
  );
  expect(f.commands[1]).toContain("revoke");
  expect(JSON.stringify(f.commands)).not.toContain("secret-token");
});

test("binds expected environment before issuing credentials", async () => {
  const f = fixture();
  await expect(
    connectT3({
      home: "/fixture/.t3",
      platform: f.platform,
      expected: { environmentId: "other", serverVersion: "0.0.41-nightly.20260909.1426" },
    }),
  ).rejects.toThrow("identity_collision");
  expect(f.commands).toHaveLength(0);
});

test("server version is diagnostic metadata, not a connection gate", async () => {
  const f = fixture();
  f.version("a-later-build");
  const c = await connectT3({
    home: "/fixture/.t3",
    platform: f.platform,
    expected: { environmentId: "env", serverVersion: "an-earlier-build" },
  });
  expect(c.runtime.serverVersion).toBe("a-later-build");
  await c.close();
});

test("editing runtime metadata cannot redirect credential-bearing requests", async () => {
  const f = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
  c.runtime.origin = "http://example.com";
  try {
    await c.request("GET", "/api/orchestration/snapshot");
    expect(f.requests.at(-1)?.url).toBe("http://127.0.0.1:3773/api/orchestration/snapshot");
  } finally {
    await c.close();
  }
});

test.each([
  ["GET", "/api/orchestration/../../admin"],
  ["GET", "/api/orchestration/dispatch"],
  ["POST", "/api/orchestration/snapshot"],
  ["GET", "/api/orchestration/snapshot?extra=1"],
  ["GET", "http://example.com/api/orchestration/snapshot"],
] as const)("rejects requests outside the adapter's HTTP contract: %s %s", async (method, path) => {
  const f = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
  const reads = f.requests.length;
  try {
    await expect(c.request(method, path)).rejects.toThrow("invalid_route");
    expect(f.requests).toHaveLength(reads);
  } finally {
    await c.close();
  }
});

test("a credential cannot be reused after close", async () => {
  const f = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
  await c.close();
  expect(() => c.request("GET", "/api/orchestration/snapshot")).toThrow("auth_closed");
  expect(f.requests).toHaveLength(1);
});

test("HTTP and JSON failures never expose response bodies", async () => {
  for (const status of [200, 401, 500]) {
    const f = fixture();
    const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
    f.platform.fetch = async () => new Response("private response with secret-token", { status });
    try {
      await expect(c.request("GET", "/api/orchestration/snapshot")).rejects.toThrow(
        status === 200 ? "request_unavailable" : `http_${status}`,
      );
    } finally {
      await c.close();
    }
  }
});

test("unavailable credentials/server and revocation failures expose only safe codes", async () => {
  const f = fixture();
  f.failAuth();
  await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow(
    "auth_unavailable",
  );
  const g = fixture();
  g.status(503);
  await expect(connectT3({ home: "/fixture/.t3", platform: g.platform })).rejects.toThrow(
    "http_503",
  );
  expect(g.commands).toHaveLength(0);
  const h = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: h.platform });
  h.failRevoke();
  await expect(c.close()).rejects.toThrow("auth_revoke_failed");
});
