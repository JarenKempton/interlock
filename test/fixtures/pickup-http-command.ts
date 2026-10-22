import { z } from "zod";
import { run } from "../../src/cli.ts";
import { localOriginGit } from "./pickup-runtime.ts";

const root = process.env.INTERLOCK_TEST_ROOT;
const endpoint = process.env.INTERLOCK_TEST_ENDPOINT;
if (!root || !endpoint) throw new Error("Fixture root and endpoint are required");
await run(Bun.argv.slice(2), console.log, {
  configuration: { cwd: root },
  execution: {
    git: localOriginGit(),
    jira: {
      async request(method, path, body) {
        const response = await fetch(endpoint, {
          method: "POST",
          body: JSON.stringify({ method, path, body }),
        });
        return z
          .object({ status: z.number(), body: z.unknown().optional() })
          .parse(await response.json());
      },
    },
  },
});
