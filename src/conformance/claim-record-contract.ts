import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lockRecordSchema } from "../adapters/claims/git-lock.ts";
import { claimPropertySchema } from "../adapters/trackers/jira.ts";
import { CLAIM_RECORD_VERSION } from "../domain/claim-lock.ts";

export const CONTRACTS_DIRECTORY = join(import.meta.dirname, "../../contracts");
export const CONTRACT_HASHES_PATH = join(CONTRACTS_DIRECTORY, "hashes.json");

export function contractFileName(version: number): string {
  return `claim-record.v${version}.json`;
}

const identifierAsString: Parameters<typeof z.toJSONSchema>[1] = {
  unrepresentable: "any",
  override: (context) => {
    if (context.zodSchema._zod.def.type === "custom") context.jsonSchema.type = "string";
  },
};

export function claimRecordContract(): string {
  const contract = {
    version: CLAIM_RECORD_VERSION,
    lockRecord: z.toJSONSchema(lockRecordSchema, identifierAsString),
    jiraClaimProperty: z.toJSONSchema(claimPropertySchema, identifierAsString),
  };
  return `${JSON.stringify(contract, null, 2)}\n`;
}

export function committedContracts(): Map<number, string> {
  const versions = new Map<number, string>();
  for (const name of readdirSync(CONTRACTS_DIRECTORY)) {
    const match = /^claim-record\.v(\d+)\.json$/.exec(name);
    if (match?.[1]) versions.set(Number(match[1]), name);
  }
  return versions;
}

export function contractHash(name: string): string {
  return createHash("sha256")
    .update(readFileSync(join(CONTRACTS_DIRECTORY, name)))
    .digest("hex");
}

export function committedContractHashes(): Record<string, string> {
  return z
    .record(z.string(), z.string())
    .parse(JSON.parse(readFileSync(CONTRACT_HASHES_PATH, "utf8")));
}
