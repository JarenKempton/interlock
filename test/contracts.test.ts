import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../src/application.ts";
import { registeredActions } from "../src/cli/catalog.ts";
import { breakingChanges, contractBreakingChanges } from "../src/conformance/contract-diff.ts";
import {
  CONTRACTS_DIRECTORY,
  committedContractFiles,
  committedContractHashes,
  contractFileName,
  contractHash,
  contractSurfaces,
  contractText,
  contractVersionFailures,
} from "../src/conformance/contracts.ts";
import { McpServer } from "../src/mcp/server.ts";

test("every committed current snapshot matches its zod schema", () => {
  for (const surface of contractSurfaces()) {
    const file = contractFileName(surface);
    expect(`${file}\n${contractText(surface)}`).toBe(
      `${file}\n${readFileSync(join(CONTRACTS_DIRECTORY, file), "utf8")}`,
    );
  }
});

test("every registered action and MCP tool has a snapshot", () => {
  const app = createApplication();
  const names = new Set(contractSurfaces().map((surface) => surface.name));
  for (const { command } of registeredActions(app))
    expect(names.has(`action.${command.join("-")}`)).toBe(true);
  const versions = new Map(
    registeredActions(app).map(({ command, action }) => [command.join(" "), action.version]),
  );
  for (const tool of new McpServer(app).tools) {
    const file = contractFileName({
      name: `action.${tool.command.join("-")}`,
      version: versions.get(tool.command.join(" ")) ?? 0,
    });
    const snapshot = JSON.parse(readFileSync(join(CONTRACTS_DIRECTORY, file), "utf8"));
    expect(snapshot.input).toEqual(tool.inputSchema);
  }
});

test("every committed snapshot is hash-locked in contracts/hashes.json", () => {
  const hashes = committedContractHashes();
  expect(Object.keys(hashes).sort()).toEqual(committedContractFiles());
  for (const file of committedContractFiles())
    expect(`${file} ${contractHash(file)}`).toBe(`${file} ${hashes[file]}`);
});

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const name = { type: "string" };
const mode = { type: "string", enum: ["a", "b"] };

test("active contract majors are positive integers and cannot roll back", () => {
  for (const version of [0, -1, 1.5, Number.NaN, 1])
    expect(
      contractVersionFailures([{ name: "action.test", version }], ["action.test.v2.json"]).length,
    ).toBeGreaterThan(0);
  expect(
    contractVersionFailures(
      [{ name: "action.test", version: 2 }],
      ["action.test.v1.json", "action.test.v2.json"],
    ),
  ).toEqual([]);
  expect(
    contractVersionFailures([{ name: "action.test", version: 3 }], ["action.test.v2.json"]),
  ).toEqual([]);
});

describe("contract classifier", () => {
  test("output guarantees cannot weaken but optional additions still pass", () => {
    const check = (before: unknown, after: unknown) =>
      contractBreakingChanges({ output: before }, { output: after });
    expect(check(object({ name }, ["name"]), object({ name })).length).toBeGreaterThan(0);
    expect(check(name, { type: ["string", "null"] }).length).toBeGreaterThan(0);
    expect(check(mode, { ...mode, enum: ["a", "b", "c"] }).length).toBeGreaterThan(0);
    expect(check({ anyOf: [name] }, { anyOf: [name, { type: "number" }] }).length).toBeGreaterThan(
      0,
    );
    expect(check(object({ name }, ["name"]), object({ name, note: name }, ["name"]))).toEqual([]);
  });

  test("new catchall constraints and boolean schemas fail closed", () => {
    expect(
      breakingChanges({ type: "object" }, { type: "object", additionalProperties: name }).length,
    ).toBeGreaterThan(0);
    expect(breakingChanges({ items: true }, { items: false }).length).toBeGreaterThan(0);
    expect(breakingChanges({ items: false }, { items: true })).toEqual([]);
    expect(breakingChanges({ items: name }, { items: [name] }).length).toBeGreaterThan(0);
    expect(breakingChanges({ items: name }, { items: null })).toEqual([
      "$[]: unsupported schema change",
    ]);
    expect(
      breakingChanges({ type: "object" }, { type: "object", additionalProperties: null }),
    ).toEqual(["$.*: unsupported schema change"]);
    expect(
      breakingChanges({ additionalProperties: false }, { additionalProperties: null }),
    ).toEqual(["$.*: unsupported schema change"]);
  });

  test("input union alternatives can be reordered or prepended", () => {
    const a = object({ kind: { const: "a" } }, ["kind"]);
    const b = object({ kind: { const: "b" } }, ["kind"]);
    const c = object({ kind: { const: "c" } }, ["kind"]);
    expect(breakingChanges({ anyOf: [a, b] }, { anyOf: [c, b, a] })).toEqual([]);
    expect(breakingChanges({ oneOf: [a, b] }, { oneOf: [a, b, {}] }).length).toBeGreaterThan(0);
  });
  test("an added optional field passes", () => {
    expect(breakingChanges(object({ name }), object({ name, note: name }))).toEqual([]);
  });

  test("a widened type, added enum value and new union option pass", () => {
    expect(
      breakingChanges(
        object({ name, mode, either: { anyOf: [name] } }),
        object({
          name: { type: ["string", "null"] },
          mode: { ...mode, enum: ["a", "b", "c"] },
          either: { anyOf: [name, { type: "number" }] },
        }),
      ),
    ).toEqual([]);
  });

  test("an optional field added inside a union option passes and a removed option fails", () => {
    const result = (value: object) => ({ anyOf: [value, object({ code: name }, ["code"])] });
    expect(breakingChanges(result(object({ name })), result(object({ name, note: name })))).toEqual(
      [],
    );
    expect(breakingChanges(result(object({ name })), { anyOf: [object({ name })] })).toEqual([
      "$: anyOf option 1 removed",
    ]);
  });

  test("a removed input or output schema fails and an added one passes", () => {
    expect(
      contractBreakingChanges({ input: object({}) }, { input: object({}), output: name }),
    ).toEqual([]);
    expect(
      contractBreakingChanges({ input: object({}), output: name }, { input: object({}) }),
    ).toEqual(["output: removed"]);
    expect(contractBreakingChanges({ output: object({ name }) }, { output: object({}) })).toEqual([
      "output.name: removed",
    ]);
  });

  test("documentation changes pass", () => {
    expect(
      breakingChanges(object({ name }), object({ name: { ...name, description: "x" } })),
    ).toEqual([]);
  });

  test("a removed field fails", () => {
    expect(breakingChanges(object({ name, note: name }), object({ name }))).toEqual([
      "$.note: removed",
    ]);
  });

  test("a renamed field fails", () => {
    expect(breakingChanges(object({ name }), object({ title: name }))).toEqual(["$.name: removed"]);
  });

  test("a newly required field fails", () => {
    expect(breakingChanges(object({ name }), object({ name, note: name }, ["note"]))).toEqual([
      "$.note: newly required",
    ]);
    expect(breakingChanges(object({ name }), object({ name }, ["name"]))).toEqual([
      "$.name: newly required",
    ]);
  });

  test("a narrowed type fails", () => {
    expect(
      breakingChanges(object({ name: { type: ["string", "null"] } }), object({ name })),
    ).toEqual(['$.name: type "null" narrowed']);
    expect(breakingChanges(object({ name }), object({ name: { ...name, minLength: 1 } }))).toEqual([
      "$.name: minLength narrowed",
    ]);
    expect(breakingChanges(object({ name }), object({ name: mode }))).toEqual([
      "$.name: enum added",
    ]);
  });

  test("a removed enum value fails", () => {
    expect(breakingChanges(object({ mode }), object({ mode: { ...mode, enum: ["a"] } }))).toEqual([
      '$.mode: enum value "b" removed',
    ]);
  });

  test("nested and array changes are found", () => {
    expect(
      breakingChanges(
        object({ list: { type: "array", items: object({ name }) } }),
        object({ list: { type: "array", items: object({}) } }),
      ),
    ).toEqual(["$.list[].name: removed"]);
  });

  test("a changed CLI positional and an unknown keyword fail", () => {
    expect(
      breakingChanges(object({ name }), object({ name: { ...name, positional: true } })),
    ).toEqual(["$.name: unclassified change to positional"]);
  });
});
