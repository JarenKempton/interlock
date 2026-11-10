#!/usr/bin/env bun
import { main } from "./app/application.ts";

export { run, VERSION } from "./app/application.ts";
export type { RuntimeServices } from "./app/runtime-services.ts";

if (import.meta.main) main(Bun.argv.slice(2));
