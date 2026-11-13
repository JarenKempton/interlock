import type { MergeProof } from "../lane/lifecycle.ts";

export interface ArtifactWorkspace {
  path: string;
  branch: string;
}

export interface ArtifactTarget extends ArtifactWorkspace {
  repository: string;
  remote: string;
  head: string;
}

export interface PullRequest {
  url: string;
  branch: string;
  title?: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export interface ArtifactRequest {
  title: string;
  body: string;
  draft: boolean;
}

export interface ArtifactUpdate {
  title: string;
  body?: string;
}

export interface ArtifactHost {
  prepare(workspace: ArtifactWorkspace, head: string): Promise<ArtifactTarget>;
  push(target: ArtifactTarget): Promise<void>;
  pullRequests(target: ArtifactTarget, key?: string): Promise<PullRequest[]>;
  open(target: ArtifactTarget, request: ArtifactRequest): Promise<PullRequest>;
  update(target: ArtifactTarget, url: string, request: ArtifactUpdate): Promise<PullRequest>;
  merged?(url: string): Promise<MergeProof>;
}
