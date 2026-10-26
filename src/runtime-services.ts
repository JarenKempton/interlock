import type { ConfigurationPlatformOptions } from "./configuration/project-files.ts";
import type { LaneTrackerPort } from "./execution/lane.ts";
import type { ExecutionPlatform } from "./execution/pickup-runtime.ts";
import type { SignInPlatform } from "./sign-in/credentials.ts";

export interface RuntimeServices {
  configuration?: ConfigurationPlatformOptions;
  statePath?: string;
  execution?: ExecutionPlatform;
  signIn?: SignInPlatform;
  lane?: { tracker?: LaneTrackerPort };
}
