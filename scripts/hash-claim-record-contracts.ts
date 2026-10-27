import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_HASHES_PATH,
  CONTRACTS_DIRECTORY,
  claimRecordContract,
  committedContractHashes,
  committedContracts,
  contractFileName,
  contractHash,
} from "../src/conformance/claim-record-contract.ts";
import { CLAIM_RECORD_VERSION } from "../src/domain/claim-lock.ts";

const current = join(CONTRACTS_DIRECTORY, contractFileName(CLAIM_RECORD_VERSION));
if (!existsSync(current)) writeFileSync(current, claimRecordContract());
const hashes = existsSync(CONTRACT_HASHES_PATH) ? committedContractHashes() : {};
for (const name of committedContracts().values()) hashes[name] ??= contractHash(name);
const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(CONTRACT_HASHES_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
console.log("wrote contracts/hashes.json");
