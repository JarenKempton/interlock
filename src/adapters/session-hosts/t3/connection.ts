import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export class T3Error extends Error {
  constructor(readonly code: string) {
    super(`T3 ${code}; preserve workspace and claim; explicit recovery required`);
    this.name = "T3Error";
  }
}

export interface T3Runtime {
  environmentId: string;
  serverVersion: string;
  origin: string;
}

export interface T3Connection {
  runtime: T3Runtime;
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface T3Platform {
  readText(path: string): Promise<string>;
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** Execute one program with argv. Capture auth stdout in memory; never invoke a shell. */
async function runCommand(argv: readonly string[]) {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { stdout, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

const platform: T3Platform = {
  readText: (path) => readFile(path, "utf8"),
  run: runCommand,
  fetch: (url, init) => fetch(url, init),
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new T3Error("invalid_response");
  return z.record(z.string(), z.unknown()).parse(value);
}

export function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new T3Error("invalid_response");
  return value;
}

/** Credentials may go only to a local HTTP origin, never a remote host or URL path. */
function localOrigin(value: unknown): string {
  try {
    const url = new URL(nonempty(value));
    const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const isBareOrigin = url.href === `${url.origin}/`;
    if (url.protocol !== "http:") throw new T3Error("unsafe_origin");
    if (!isLoopback) throw new T3Error("unsafe_origin");
    if (!isBareOrigin) throw new T3Error("unsafe_origin");
    return url.origin;
  } catch {
    throw new T3Error("unsafe_origin");
  }
}

export interface T3ConnectOptions {
  home?: string;
  command?: string;
  platform?: T3Platform;
  /** Match the durable environment ID. A recorded server version is diagnostic only. */
  expected?: Pick<T3Runtime, "environmentId" | "serverVersion">;
}

async function discoverLocalServer(io: T3Platform, home: string) {
  for (const directory of ["userdata", "dev"]) {
    let raw: string;
    try {
      raw = await io.readText(join(home, directory, "server-runtime.json"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new T3Error("discovery_unavailable");
    }
    // Only an absent file permits fallback. Invalid or unreadable state never does.
    let state: Record<string, unknown>;
    try {
      state = object(JSON.parse(raw));
    } catch {
      throw new T3Error("invalid_discovery");
    }
    // This is the discovery FILE format, not a pinned T3 software version.
    if (state.version !== 1) throw new T3Error("invalid_discovery");
    return { origin: localOrigin(state.origin), directory };
  }
  throw new T3Error("server_unavailable");
}

const httpRoutes = new Set([
  "GET /.well-known/t3/environment",
  "GET /api/orchestration/snapshot",
  "POST /api/orchestration/dispatch",
]);

/** Native Fetch does HTTP/JSON; this boundary restricts routes and keeps errors secret-free. */
async function requestJson(
  io: T3Platform,
  origin: string,
  request: { method: "GET" | "POST"; path: string; token?: string; body?: unknown },
): Promise<unknown> {
  if (!httpRoutes.has(`${request.method} ${request.path}`)) throw new T3Error("invalid_route");
  if (request.method === "GET" && request.body !== undefined) throw new T3Error("invalid_request");
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (request.token) headers.Authorization = `Bearer ${request.token}`;
    const response = await io.fetch(`${origin}${request.path}`, {
      method: request.method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    if (!response.ok) throw new T3Error(`http_${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof T3Error) throw error;
    throw new T3Error("request_unavailable");
  }
}

async function readEnvironment(io: T3Platform, origin: string): Promise<T3Runtime> {
  const descriptor = object(
    await requestJson(io, origin, { method: "GET", path: "/.well-known/t3/environment" }),
  );
  return {
    origin,
    environmentId: nonempty(descriptor.environmentId),
    serverVersion: nonempty(descriptor.serverVersion),
  };
}

async function revokeCredential(io: T3Platform, command: string, home: string, sessionId: string) {
  try {
    const revoked = await io.run([
      command,
      "auth",
      "session",
      "revoke",
      sessionId,
      "--base-dir",
      home,
    ]);
    if (revoked.exitCode !== 0) throw new T3Error("auth_revoke_failed");
  } catch {
    throw new T3Error("auth_revoke_failed");
  }
}

async function issueCredential(io: T3Platform, command: string, home: string) {
  let auth: Record<string, unknown>;
  try {
    // T3 requires a bearer credential even for snapshot reads. This is API auth,
    // not an agent session. Label/subject identify the calling client in T3's auth records.
    // One CLI invocation: `t3 auth session issue` plus flags for a two-minute credential.
    const issued = await io.run([
      command,
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
      home,
    ]);
    if (issued.exitCode !== 0) throw new T3Error("auth_unavailable");
    auth = object(JSON.parse(issued.stdout));
  } catch {
    throw new T3Error("auth_unavailable");
  }
  const sessionId = nonempty(auth.sessionId);
  try {
    const token = nonempty(auth.token);
    if (auth.method !== "bearer-access-token") throw new T3Error("auth_unavailable");
    return { sessionId, token };
  } catch {
    await revokeCredential(io, command, home, sessionId);
    throw new T3Error("auth_unavailable");
  }
}

/** Discover → read identity → authenticate. Closing revokes the temporary credential. */
export async function connectT3(options: T3ConnectOptions = {}): Promise<T3Connection> {
  const io = options.platform ?? platform;
  const home = options.home ?? join(homedir(), ".t3");
  const command = options.command ?? "t3";
  const server = await discoverLocalServer(io, home);
  const runtime = await readEnvironment(io, server.origin);
  if (options.expected && runtime.environmentId !== options.expected.environmentId)
    throw new T3Error("identity_collision");
  if (server.directory === "dev") throw new T3Error("dev_auth_unqualified");
  const credential = await issueCredential(io, command, home);
  return {
    runtime,
    request: (method, path, body) => {
      if (!credential.token) throw new T3Error("auth_closed");
      return requestJson(io, server.origin, { method, path, body, token: credential.token });
    },
    async close() {
      credential.token = "";
      await revokeCredential(io, command, home, credential.sessionId);
    },
  };
}
