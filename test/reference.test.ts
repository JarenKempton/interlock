import { describe, expect, test } from "bun:test";
import { parseRef } from "../src/domain/reference.ts";

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

  test.each(["JWB-245", "jira:", "jira:x:y:map", "jira:x:y:other:z", "interlock-run:"])(
    "rejects %s",
    (raw) => expect(() => parseRef(raw)).toThrow(),
  );
});
