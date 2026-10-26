import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const directory = "src/persistence/migrations";
const hashesPath = join(directory, "hashes.json");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const computed: Record<string, string> = {};
for (const file of files) {
  computed[file] = createHash("sha256")
    .update(readFileSync(join(directory, file)))
    .digest("hex");
}
if (process.argv.includes("--write")) {
  writeFileSync(hashesPath, `${JSON.stringify(computed, null, 2)}\n`);
  console.log(`wrote ${hashesPath}`);
  process.exit(0);
}
if (!existsSync(hashesPath)) throw new Error(`Missing ${hashesPath}; run bun run db:hash`);
const committed = z
  .record(z.string(), z.string())
  .parse(JSON.parse(readFileSync(hashesPath, "utf8")));
const edited = files.filter((file) => committed[file] !== computed[file]);
const missing = Object.keys(committed).filter((file) => !files.includes(file));
if (edited.length > 0) throw new Error(`Committed migration was edited: ${edited.join(", ")}`);
if (missing.length > 0) throw new Error(`Committed migration is missing: ${missing.join(", ")}`);
console.log(`verified ${files.length} migration(s)`);
