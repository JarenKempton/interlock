import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { onlyBaseMerges } from "../../adapters/git/base-merges.ts";
import { GitClaimLock } from "../../adapters/git/claim-lock.ts";
import { BunGitCommandExecutor, type GitCommandExecutor } from "../../adapters/git/workspace.ts";
import { configuredPickable } from "../../configuration/pickable.ts";
import { getExecutionConfiguration } from "../../configuration/store.ts";
import { LaneService, type LaneServiceOptions } from "../../execution/lane/service.ts";
import type { StateStore } from "../../persistence/state.ts";

export type GitLaneServiceOptions = Omit<
  LaneServiceOptions,
  "store" | "claimLock" | "canonicalPath" | "pickable" | "baseMergesOnly"
> & { store: StateStore; git?: GitCommandExecutor | undefined };

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolve(path);
    throw error;
  });
}

export function gitLaneService({
  git = new BunGitCommandExecutor(),
  ...options
}: GitLaneServiceOptions): LaneService {
  return new LaneService({
    ...options,
    claimLock: (repository, home) => new GitClaimLock({ repository, home, git }),
    canonicalPath,
    baseMergesOnly: (path, approved, proof) => onlyBaseMerges(git, path, approved, proof),
    pickable: (run) => {
      const configuration = getExecutionConfiguration(options.store, run);
      return configuration ? configuredPickable(configuration) : undefined;
    },
  });
}
