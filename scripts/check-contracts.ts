import { contractBreakingChanges } from "../src/conformance/contract-diff.ts";
import {
  committedContract,
  committedContractFiles,
  committedContractHashes,
  committedDefinitions,
  contractFileName,
  contractHash,
  contractSurfaces,
  contractVersionFailures,
  type Definitions,
  definitionFailures,
  definitionsSchema,
  hashesSchema,
  parseContractFileName,
  resolveContract,
} from "../src/conformance/contracts.ts";

const base = process.argv[2];
if (!base) throw new Error("Usage: bun scripts/check-contracts.ts <base-ref>");
if (Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${base}^{commit}`]).exitCode !== 0)
  throw new Error(`Base ref ${base} is not a commit; fetch it first`);

function show(path: string): string | undefined {
  const result = Bun.spawnSync(["git", "show", `${base}:contracts/${path}`]);
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

const baseText = show("hashes.json");
const baseHashes = baseText ? hashesSchema.parse(JSON.parse(baseText)) : {};
const baseDefinitionsText = show("definitions.json");
const baseDefinitions = baseDefinitionsText
  ? definitionsSchema.parse(JSON.parse(baseDefinitionsText))
  : {};
const headHashes = committedContractHashes();
const headDefinitions = committedDefinitions();
const surfaces = contractSurfaces();
const current = new Map(surfaces.map((surface) => [contractFileName(surface), surface]));
const names = new Set(surfaces.map((surface) => surface.name));
const failures = contractVersionFailures(surfaces, [
  ...Object.keys(baseHashes),
  ...Object.keys(headHashes),
  ...committedContractFiles(),
]);
failures.push(...definitionFailures(headDefinitions));
const additive: string[] = [];

function resolved(file: string, document: unknown, definitions: Definitions): unknown {
  try {
    return resolveContract(document, definitions);
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

for (const file of committedContractFiles())
  resolved(file, committedContract(file), headDefinitions);

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
  const baseFile = show(file);
  if (baseFile === undefined) {
    failures.push(`${base}:${file}: listed in base hashes but unreadable`);
    continue;
  }
  const before = resolved(`${base}:${file}`, JSON.parse(baseFile), baseDefinitions);
  const after = resolved(file, committedContract(file), headDefinitions);
  if (before === undefined || after === undefined) continue;
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
