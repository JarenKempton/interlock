import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { localOriginGit, PickupJira } from "./pickup-runtime.ts";

const root = process.env.INTERLOCK_TEST_ROOT;
if (!root) throw new Error("Fixture root is required");
const path = join(root, "jira.json");
const jira = new PickupJira();
Object.assign(jira, JSON.parse(readFileSync(path, "utf8")));
try {
  await run(Bun.argv.slice(2), console.log, {
    configuration: { cwd: process.env.INTERLOCK_TEST_CWD ?? root },
    execution: { jira, git: localOriginGit() },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(path, JSON.stringify({ issue: jira.issue, property: jira.property }));
}
