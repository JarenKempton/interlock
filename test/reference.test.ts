import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  capabilities,
  missingCapabilities,
  requireCapabilities,
} from "../src/domain/model.ts";
import { parseRef, workspaceRefOf } from "../src/domain/reference.ts";

describe("parseRef", () => {
  test.each([
    ["jira:responsibid", "tracker"],
    ["jira:responsibid:JWB", "workspace"],
    ["jira:responsibid:JWB:group:JWB-150", "group"],
    ["jira:responsibid:JWB:map:JWB-239", "map"],
    ["jira:responsibid:JWB:ticket:JWB-245", "ticket"],
    ["interlock-run:018f", "run"],
    ["interlock-claim:018f", "claim"],
  ] as const)("parses %s", (raw, kind) => expect(parseRef(raw).kind).toBe(kind));

  test.each([
    "JWB-245",
    "jira:",
    "jira:x:y:map",
    "jira:x:y:other:z",
    "interlock-run:",
    "nav-run:018f",
    "nav-claim:018f",
  ])("rejects %s", (raw) => expect(() => parseRef(raw)).toThrow());
});

test("derives the same qualified workspace from workspace-owned references", () => {
  expect(workspaceRefOf("jira:responsibid:JWB")).toBe("jira:responsibid:JWB");
  expect(workspaceRefOf("jira:responsibid:JWB:group:JWB-100")).toBe("jira:responsibid:JWB");
  expect(workspaceRefOf("jira:responsibid:JWB:map:JWB-239")).toBe("jira:responsibid:JWB");
  expect(workspaceRefOf("jira:responsibid:JWB:ticket:JWB-245")).toBe("jira:responsibid:JWB");
  expect(() => workspaceRefOf("jira:responsibid")).toThrow("not owned by a workspace");
});

test("reports missing capabilities", () => {
  expect(
    missingCapabilities(capabilities("native_maps"), capabilities("native_maps", "claim_comments")),
  ).toEqual(["claim_comments"]);
});

test("capability vocabulary is unique and protocol-safe", () => {
  expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  for (const capability of CAPABILITIES) {
    expect(capability).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
  }
});

test("unsupported capabilities fail explicitly with a stable code", () => {
  expect(() =>
    requireCapabilities(
      capabilities("native_maps"),
      capabilities("native_maps", "conditional_update", "claim_comments"),
    ),
  ).toThrow(
    expect.objectContaining({
      name: "UnsupportedCapabilityError",
      code: "unsupported_capability",
      missing: ["conditional_update", "claim_comments"],
    }),
  );
});
