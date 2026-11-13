import type { ExternalCliSignIn } from "../../../domain/tracker/port.ts";
import { githubOwner } from "./tracker.ts";
import type { GitHubTransport } from "./transport.ts";

export function githubSignIn(transport: GitHubTransport): ExternalCliSignIn {
  const owner = githubOwner(transport);
  return {
    kind: "external_cli",
    command: "gh auth login",
    verify: async () => ({ name: await owner() }),
  };
}
