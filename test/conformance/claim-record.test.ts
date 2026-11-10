import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLockRecordMessage } from "../../src/adapters/git/claim-lock.ts";
import { parseClaimProperty } from "../../src/adapters/trackers/jira/tracker.ts";
import { claimRecordContract } from "../../src/conformance/claim-record.ts";
import { CLAIM_RECORD_VERSION } from "../../src/domain/claim/lock.ts";

const fixtures = join(import.meta.dirname, "../fixtures/claim-records");

test("the claim record shape matches the frozen v2 contract", () => {
  expect(CLAIM_RECORD_VERSION).toBe(2);
  expect(claimRecordContract()).toBe(
    readFileSync(join(import.meta.dirname, "../../contracts/claim-record.v2.json"), "utf8"),
  );
});

test.each([
  [
    "../../contracts/claim-record.v2.json",
    "bcc406e6eede36b81fc6e69decbe58d62b7223085ec1043360da07699e1aa55e",
  ],
  [
    "../fixtures/claim-records/v2-lock-commit.txt",
    "90ec06dd48e01e81dd8aaea37e1385e324c440354320b347ae3a6eaed85d310e",
  ],
  [
    "../fixtures/claim-records/v2-jira-property.json",
    "fe43ce283e12a4a5f405311736468d9d4a0fe89231593831891647c66c1dba88",
  ],
])("%s stays byte-frozen", (file, hash) => {
  const bytes = readFileSync(join(import.meta.dirname, file));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
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
