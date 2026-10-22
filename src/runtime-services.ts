import type { ConfigurationPlatformOptions } from "./configuration/project-files.ts";
import type { ExecutionPlatform } from "./execution/pickup-runtime.ts";

export interface RuntimeServices {
  configuration?: ConfigurationPlatformOptions;
  statePath?: string;
  execution?: ExecutionPlatform;
}
