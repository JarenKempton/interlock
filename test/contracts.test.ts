import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../src/application.ts";
import { registeredActions } from "../src/cli/catalog.ts";
import { breakingChanges } from "../src/conformance/contract-diff.ts";
import {
  CONTRACTS_DIRECTORY,
  committedContractFiles,
  committedContractHashes,
  contractFileName,
  contractHash,
  contractSurfaces,
  contractText,
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
  const tools = new McpServer(app).tools;
  for (const tool of tools) {
    const snapshot = JSON.parse(
      readFileSync(join(CONTRACTS_DIRECTORY, `action.${tool.command.join("-")}.v1.json`), "utf8"),
    );
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

describe("contract classifier", () => {
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
