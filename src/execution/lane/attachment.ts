import type { Claim, Run } from "../../domain/model.ts";

export interface AttachAuthority {
  verify(run: Run, claim: Claim, worktree: string): Promise<void>;
}

export class AttachRefusal extends Error {
  constructor(
    readonly code: "workspace_unknown" | "claim_collision",
    message: string,
  ) {
    super(message);
  }
}
