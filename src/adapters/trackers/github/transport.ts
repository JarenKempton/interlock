import { tmpdir } from "node:os";
import { BunGitCommandExecutor, type GitCommandExecutor } from "../../git/workspace.ts";

export interface GitHubResponse {
  status: number;
  body?: unknown;
}

export type GitHubFields = Readonly<Record<string, string | readonly string[]>>;

export interface GitHubTransport {
  request(method: string, path: string, fields?: GitHubFields): Promise<GitHubResponse>;
}

export function ghCliTransport(
  commands: GitCommandExecutor = new BunGitCommandExecutor(),
): GitHubTransport {
  return {
    async request(method, path, fields = {}) {
      if (!/^(repos\/|user$)/.test(path))
        throw new Error("GitHub request path must be a REST path");
      const result = await commands.run(
        ["gh", "api", "--include", "-X", method, path, ...fieldArguments(fields)],
        tmpdir(),
      );
      const response = parseIncluded(result.stdout);
      if (!response) throw new Error(`gh api exited ${result.exitCode}: ${result.stderr.trim()}`);
      return response;
    },
  };
}

function fieldArguments(fields: GitHubFields): string[] {
  return Object.entries(fields).flatMap(([name, value]) =>
    typeof value === "string"
      ? ["-f", `${name}=${value}`]
      : value.flatMap((item) => ["-f", `${name}[]=${item}`]),
  );
}

export function parseIncluded(output: string): GitHubResponse | undefined {
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(output);
  if (!status) return undefined;
  const separator = /\r?\n\r?\n/.exec(output);
  const text = separator ? output.slice(separator.index + separator[0].length).trim() : "";
  const code = Number(status[1]);
  if (!text) return { status: code };
  try {
    return { status: code, body: JSON.parse(text) };
  } catch {
    return { status: code };
  }
}
