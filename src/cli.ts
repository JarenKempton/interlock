#!/usr/bin/env bun
import { createApplication } from "./application.ts";
import { dispatch } from "./cli/command-line.ts";
import { notifyAboutUpdate } from "./distribution/update.ts";
import { VERSION } from "./distribution/version.ts";
import type { RuntimeServices } from "./runtime-services.ts";

export { VERSION } from "./distribution/version.ts";
export type { RuntimeServices } from "./runtime-services.ts";

export async function run(
  args: string[],
  write: (text: string) => void = console.log,
  services: RuntimeServices = {},
): Promise<void> {
  await dispatch(createApplication(services), args, write);
}

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then(() =>
      notifyAboutUpdate({
        currentVersion: VERSION,
        interactive: Boolean(process.stdout.isTTY && process.stderr.isTTY),
        json: Bun.argv.slice(2).includes("--json"),
      }),
    )
    .catch((error: unknown) => {
      console.error(`interlock: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
