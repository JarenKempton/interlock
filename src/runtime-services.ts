import type { ConfigurationPlatformOptions } from "./configuration/project-files.ts";

export interface RuntimeServices {
  configuration?: ConfigurationPlatformOptions;
  statePath?: string;
}
