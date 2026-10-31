import { createHash, randomUUID } from "node:crypto";
import type { ClaimHome } from "../../domain/claim-home.ts";
import {
  commitOidSchema,
  type SubmissionAuthority,
  type SubmissionIdentity,
  type SubmissionRecord,
  SubmissionRefusal,
  sameSubmission,
  submissionRecordSchema,
} from "../../domain/submission.ts";
import type { GitCommandExecutor } from "../workspaces/git.ts";
import { checkedGitCommand, verifyRemoteDestination } from "../workspaces/remote.ts";

export function submissionRef(identity: SubmissionIdentity): string {
  const key = identity.ticket ?? identity.lane;
  return `refs/interlock/submissions/v1/${createHash("sha256").update(key).digest("hex")}`;
}

export class GitSubmissionAuthority implements SubmissionAuthority {
  constructor(
    readonly home: ClaimHome,
    private readonly git: GitCommandExecutor,
  ) {}

  async read(identity: SubmissionIdentity, cwd: string): Promise<SubmissionRecord | undefined> {
    const ref = submissionRef(identity);
    const tip = await this.tip(ref, cwd);
    if (!tip) return undefined;
    await checkedGitCommand(this.git, cwd, ["git", "fetch", "--no-tags", this.home.url, ref]);
    const commit = await checkedGitCommand(this.git, cwd, ["git", "cat-file", "commit", tip]);
    const record = submissionRecordSchema.parse(
      JSON.parse(commit.slice(commit.indexOf("\n\n") + 2)),
    );
    if (!sameSubmission(record.identity, identity))
      throw new SubmissionRefusal(
        "duplicate_artifact",
        "Ticket already has another submission owner",
      );
    return record;
  }

  async reserve(identity: SubmissionIdentity, cwd: string): Promise<{ mayCreate: boolean }> {
    if (await this.read(identity, cwd)) return { mayCreate: false };
    const record = submissionRecordSchema.parse({ version: 1, identity, attempt: randomUUID() });
    const tree = await checkedGitCommand(this.git, cwd, ["git", "mktree"]);
    const candidate = commitOidSchema.parse(
      await checkedGitCommand(this.git, cwd, [
        "git",
        "-c",
        "user.name=Interlock",
        "-c",
        "user.email=interlock@invalid",
        "commit-tree",
        tree,
        "-m",
        JSON.stringify(record),
      ]),
    );
    const ref = submissionRef(identity);
    await verifyRemoteDestination(this.git, cwd, this.home.url);
    try {
      await this.git.run(["git", "push", "--porcelain", this.home.url, `${candidate}:${ref}`], cwd);
    } catch {}
    let tip: string | undefined;
    try {
      tip = await this.tip(ref, cwd);
    } catch {
      throw new SubmissionRefusal(
        "recovery_required",
        "Submission reservation push is unverified; no PR create was authorized",
      );
    }
    if (tip === candidate) return { mayCreate: true };
    if (tip) {
      await this.read(identity, cwd);
      return { mayCreate: false };
    }
    throw new SubmissionRefusal(
      "recovery_required",
      "Submission reservation is unverified; no PR create was authorized",
    );
  }

  private async tip(ref: string, cwd: string): Promise<string | undefined> {
    await verifyRemoteDestination(this.git, cwd, this.home.url);
    const output = await checkedGitCommand(this.git, cwd, ["git", "ls-remote", this.home.url, ref]);
    const lines = output.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return undefined;
    if (lines.length !== 1 || lines[0]?.split("\t")[1] !== ref)
      throw new Error("Invalid submission reservation readback");
    return commitOidSchema.parse(lines[0].split("\t")[0]);
  }
}
