import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLockRecordMessage } from "../src/adapters/claims/git-lock.ts";
import { parseClaimProperty } from "../src/adapters/trackers/jira.ts";
import {
  committedContractFiles,
  contractFileName,
  contractSurfaces,
  contractText,
  parseContractFileName,
} from "../src/conformance/contracts.ts";
import { CLAIM_RECORD_VERSION } from "../src/domain/claim-lock.ts";

const fixtures = join(import.meta.dirname, "fixtures/claim-records");

const claimRecord = contractSurfaces().find((surface) => surface.name === "claim-record");

test("CLAIM_RECORD_VERSION is the highest committed claim record contract", () => {
  const versions = committedContractFiles()
    .map(parseContractFileName)
    .filter((parsed) => parsed?.name === "claim-record")
    .map((parsed) => parsed?.version ?? 0);
  expect(CLAIM_RECORD_VERSION).toBe(Math.max(...versions));
});

test("the claim record shape matches the frozen contract for its version", () => {
  if (!claimRecord) throw new Error("claim-record surface is not registered");
  expect(claimRecord.frozen).toBe(true);
  expect(contractFileName(claimRecord)).toBe(`claim-record.v${CLAIM_RECORD_VERSION}.json`);
  expect(contractText(claimRecord)).toBe(
    readFileSync(join(import.meta.dirname, "../contracts", contractFileName(claimRecord)), "utf8"),
  );
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
