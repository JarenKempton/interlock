import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractBreakingChanges } from "../src/conformance/contract-diff.ts";
import {
  CONTRACT_HASHES_PATH,
  CONTRACTS_DIRECTORY,
  committedContractFiles,
  committedContractHashes,
  contentHash,
  contractFileName,
  contractSurfaces,
  contractText,
} from "../src/conformance/contracts.ts";

const hashes = committedContractHashes();
const refused: string[] = [];
for (const surface of contractSurfaces()) {
  const file = contractFileName(surface);
  const path = join(CONTRACTS_DIRECTORY, file);
  const next = contractText(surface);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === next) continue;
    const breaking = contractBreakingChanges(JSON.parse(current), JSON.parse(next));
    if (surface.frozen || breaking.length > 0) {
      refused.push(
        `${file}: ${surface.frozen ? "frozen; bump its version" : `breaking without a major bump: ${breaking.join("; ")}`}`,
      );
      continue;
    }
  }
  writeFileSync(path, next);
  hashes[file] = contentHash(next);
}
for (const file of committedContractFiles())
  hashes[file] ??= contentHash(readFileSync(join(CONTRACTS_DIRECTORY, file)));
const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(CONTRACT_HASHES_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
if (refused.length > 0) {
  console.error(refused.join("\n"));
  process.exit(1);
}
console.log("wrote contracts/");
