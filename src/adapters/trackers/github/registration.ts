import type { GitCommandExecutor } from "../../git/workspace.ts";
import type { Ticket } from "../../../domain/tracker/ticket.ts";
import { githubInstance, githubNamespace, githubRepository, githubRepositoryOf } from "./refs.ts";
import { githubSignIn } from "./sign-in.ts";
import { GitHubIssuesTracker, githubOwner } from "./tracker.ts";
import { type GitHubTransport, ghCliTransport } from "./transport.ts";

interface GitHubServices {
  execution?: { github?: GitHubTransport; git?: GitCommandExecutor };
}

interface GitHubTrackerOptions {
  claimedStatus?: string;
  validateClaim?: (ticket: Ticket) => void | Promise<void>;
}

function transport(services: GitHubServices): GitHubTransport {
  return services.execution?.github ?? ghCliTransport(services.execution?.git);
}

export const githubIssues = {
  name: "github",
  label: "GitHub Issues",
  setting: "github_repo",
  signIn: (services: GitHubServices) => githubSignIn(transport(services)),
  instance: githubInstance,
  siteOf: githubRepositoryOf,
  namespace: githubNamespace,
  async connect(services: GitHubServices, site: string) {
    const issues = transport(services);
    return {
      instance: githubInstance(githubRepository(site)),
      owner: githubOwner(issues),
      tracker: ({ claimedStatus, validateClaim }: GitHubTrackerOptions = {}) =>
        new GitHubIssuesTracker({
          transport: issues,
          ...(claimedStatus ? { claimedStatus } : {}),
          ...(validateClaim ? { validateClaim } : {}),
        }),
    };
  },
} as const;
