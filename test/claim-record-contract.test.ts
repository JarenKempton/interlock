import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLockRecordMessage } from "../src/adapters/claims/git-lock.ts";
import { parseClaimProperty } from "../src/adapters/trackers/jira.ts";
import {
  CONTRACTS_DIRECTORY,
  claimRecordContract,
  committedContractHashes,
  committedContracts,
  contractFileName,
  contractHash,
} from "../src/conformance/claim-record-contract.ts";
import { CLAIM_RECORD_VERSION } from "../src/domain/claim-lock.ts";

const fixtures = join(import.meta.dirname, "fixtures/claim-records");

test("CLAIM_RECORD_VERSION is the highest committed claim record contract", () => {
  expect(CLAIM_RECORD_VERSION).toBe(Math.max(...committedContracts().keys()));
});

test("the claim record shape matches the frozen contract for its version", () => {
  const frozen = readFileSync(
    join(CONTRACTS_DIRECTORY, contractFileName(CLAIM_RECORD_VERSION)),
    "utf8",
  );
  expect(claimRecordContract()).toBe(frozen);
});

test("committed claim record contracts are never edited", () => {
  const hashes = committedContractHashes();
  const names = [...committedContracts().values()].sort();
  expect(Object.keys(hashes).sort()).toEqual(names);
  for (const name of names) expect(`${name} ${contractHash(name)}`).toBe(`${name} ${hashes[name]}`);
});

test("the current reader accepts a v2 lock commit message", () => {
  const message = readFileSync(join(fixtures, "v2-lock-commit.txt"), "utf8");
  expect(parseLockRecordMessage(message, "fixture")).toEqual(
    JSON.parse(message.slice(message.indexOf("\n\n") + 2)),
  );
});

test("the current reader accepts a v2 Jira claim property", () => {
  const body = JSON.parse(readFileSync(join(fixtures, "v2-jira-property.json"), "utf8"));
  expect(parseClaimProperty(body, "interlock.claim", "JWB-123")).toEqual(body.value);
});
