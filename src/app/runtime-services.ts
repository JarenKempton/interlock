import type { ConfigurationPlatformOptions } from "../configuration/project-files.ts";
import type { AttachAuthority } from "./lane/attachment.ts";
import type { ArtifactHost, LaneTrackerPort } from "../execution/lane/service.ts";
import type { ExecutionPlatform } from "./pickup/runtime.ts";
import type { SignInPlatform } from "../sign-in/credentials.ts";

export interface RuntimeServices {
  configuration?: ConfigurationPlatformOptions;
  statePath?: string;
  execution?: ExecutionPlatform;
  signIn?: SignInPlatform;
  lane?: {
    tracker?: LaneTrackerPort;
    artifacts?: ArtifactHost;
    attachments?: AttachAuthority;
  };
}
