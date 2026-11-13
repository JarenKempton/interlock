import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface T3CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface T3Process {
  run(argv: readonly string[], stdin?: string): Promise<T3CommandResult>;
}

export const bunT3Process: T3Process = {
  async run(argv, stdin) {
    const child = Bun.spawn([...argv], {
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  },
};

export function hostT3Cli(env: Record<string, string | undefined> = process.env): string {
  return env.T3CODE_CLI_PATH || "t3";
}

const runtimeStateSchema = z.object({ origin: z.url() });

export async function readT3ServerDescriptor(
  home = process.env.T3CODE_HOME || join(homedir(), ".t3"),
): Promise<unknown> {
  const state = runtimeStateSchema.parse(
    JSON.parse(await readFile(join(home, "userdata", "server-runtime.json"), "utf8")),
  );
  const response = await fetch(new URL("/.well-known/t3/environment", state.origin), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`T3 server answered ${response.status}`);
  return response.json();
}

export const descriptorSchema = z.object({
  environmentId: z.string().min(1),
  serverVersion: z.string().min(1),
  orchestrationProtocolVersion: z.number(),
});

export const launchedSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
});

export const threadSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string(),
  link: z.string().optional(),
  status: z.string(),
  providerInstanceId: z.string().min(1),
  model: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
});

export const showSchema = z.object({
  thread: threadSchema,
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
});

export const listSchema = z.array(threadSchema.omit({ branch: true, worktreePath: true }));

export const sentSchema = z.object({ threadId: z.string().min(1) });

export async function sendT3Message(
  process: T3Process,
  cli: string,
  thread: string,
  message: string,
): Promise<T3CommandResult & { delivered: boolean }> {
  let result: T3CommandResult;
  try {
    result = await process.run(
      [cli, "--log-level", "error", "thread", "send", thread, "-", "--json"],
      message,
    );
  } catch (error) {
    result = {
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const sent = result.exitCode === 0 ? parseJson(sentSchema, result.stdout) : undefined;
  return { ...result, delivered: sent?.threadId === thread };
}

export function parseJson<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function versionCore(version: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(version.trim())?.[1];
}
