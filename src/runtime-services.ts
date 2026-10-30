import type { ConfigurationPlatformOptions } from "./configuration/project-files.ts";
import type { SubmissionAuthority } from "./domain/submission.ts";
import type { ArtifactHost, LaneTrackerPort } from "./execution/lane.ts";
import type { ExecutionPlatform } from "./execution/pickup-runtime.ts";
import type { SignInPlatform } from "./sign-in/credentials.ts";

export interface RuntimeServices {
  configuration?: ConfigurationPlatformOptions;
  statePath?: string;
  execution?: ExecutionPlatform;
  signIn?: SignInPlatform;
  lane?: { tracker?: LaneTrackerPort; artifacts?: ArtifactHost; submissions?: SubmissionAuthority };
}
