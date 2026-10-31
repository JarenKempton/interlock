import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractBreakingChanges } from "../src/conformance/contract-diff.ts";
import {
  CONTRACT_DEFINITIONS_PATH,
  CONTRACT_HASHES_PATH,
  CONTRACTS_DIRECTORY,
  committedContractDefinitions,
  committedContractFiles,
  committedContractHashes,
  committedDefinitions,
  contentHash,
  contractFileName,
  contractSet,
  contractSurfaces,
  contractVersionFailures,
  definitionsText,
  resolveContract,
} from "../src/conformance/contracts.ts";

const hashes = committedContractHashes();
const committed = committedDefinitions();
const surfaces = contractSurfaces();
const refused = contractVersionFailures(surfaces, [
  ...committedContractFiles(),
  ...Object.keys(hashes),
]);
if (refused.length > 0) throw new Error(refused.join("\n"));
const { texts, definitions } = contractSet(surfaces);
for (const surface of surfaces) {
  const file = contractFileName(surface);
  const path = join(CONTRACTS_DIRECTORY, file);
  const next = texts.get(file);
  if (next === undefined) throw new Error(`${file}: not generated`);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === next) continue;
    const breaking = contractBreakingChanges(
      resolveContract(JSON.parse(current), committed),
      resolveContract(JSON.parse(next), definitions),
    );
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
writeFileSync(
  CONTRACT_DEFINITIONS_PATH,
  definitionsText(committedContractDefinitions({ ...committed, ...definitions })),
);
if (refused.length > 0) {
  console.error(refused.join("\n"));
  process.exit(1);
}
console.log("wrote contracts/");
