import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contractBreakingChanges } from "../src/conformance/contract-diff.ts";
import {
  CONTRACTS_DIRECTORY,
  committedContractHashes,
  contractFileName,
  contractHash,
  contractSurfaces,
  hashesSchema,
  parseContractFileName,
} from "../src/conformance/contracts.ts";

const base = process.argv[2];
if (!base) throw new Error("Usage: bun scripts/check-contracts.ts <base-ref>");

function show(path: string): string | undefined {
  const result = Bun.spawnSync(["git", "show", `${base}:contracts/${path}`]);
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

const baseText = show("hashes.json");
const baseHashes = baseText ? hashesSchema.parse(JSON.parse(baseText)) : {};
const headHashes = committedContractHashes();
const surfaces = contractSurfaces();
const current = new Map(surfaces.map((surface) => [contractFileName(surface), surface]));
const names = new Set(surfaces.map((surface) => surface.name));
const failures: string[] = [];
const additive: string[] = [];

for (const [file, hash] of Object.entries(baseHashes)) {
  const name = parseContractFileName(file)?.name;
  if (name && !names.has(name)) failures.push(`${file}: surface removed`);
  if (headHashes[file] === undefined) {
    failures.push(`${file}: released snapshot removed`);
    continue;
  }
  let headHash: string;
  try {
    headHash = contractHash(file);
  } catch {
    failures.push(`${file}: released snapshot removed`);
    continue;
  }
  if (headHash !== headHashes[file]) failures.push(`${file}: does not match contracts/hashes.json`);
  if (headHash === hash) continue;
  const surface = current.get(file);
  if (!surface || surface.frozen) {
    failures.push(`${file}: hash-locked snapshot changed`);
    continue;
  }
  const before = JSON.parse(show(file) ?? "{}");
  const after = JSON.parse(readFileSync(join(CONTRACTS_DIRECTORY, file), "utf8"));
  const breaking = contractBreakingChanges(before, after);
  if (breaking.length > 0)
    failures.push(`${file}: breaking change without a major bump\n  ${breaking.join("\n  ")}`);
  else additive.push(`${file}: additive`);
}

for (const line of additive) console.log(line);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`contracts compatible with ${base}`);
