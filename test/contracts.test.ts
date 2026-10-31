import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createApplication } from "../src/application.ts";
import { registeredActions } from "../src/cli/catalog.ts";
import { breakingChanges, contractBreakingChanges } from "../src/conformance/contract-diff.ts";
import {
  CONTRACT_DEFINITIONS_PATH,
  CONTRACTS_DIRECTORY,
  type ContractSurface,
  committedContract,
  committedContractDefinitions,
  committedContractFiles,
  committedContractHashes,
  committedDefinitions,
  contractFileName,
  contractHash,
  contractSet,
  contractSurfaces,
  contractVersionFailures,
  definitionFailures,
  definitionsText,
  resolveContract,
} from "../src/conformance/contracts.ts";
import { laneSchema } from "../src/domain/lane.ts";
import { McpServer } from "../src/mcp/server.ts";

test("every committed current snapshot matches its zod schema", () => {
  const surfaces = contractSurfaces();
  const { texts, definitions } = contractSet(surfaces);
  for (const surface of surfaces) {
    const file = contractFileName(surface);
    expect(`${file}\n${texts.get(file)}`).toBe(
      `${file}\n${readFileSync(join(CONTRACTS_DIRECTORY, file), "utf8")}`,
    );
    expect(resolveContract(JSON.parse(texts.get(file) ?? ""), definitions)).toEqual(
      surface.document(),
    );
  }
  expect(readFileSync(CONTRACT_DEFINITIONS_PATH, "utf8")).toBe(
    definitionsText(committedContractDefinitions({ ...committedDefinitions(), ...definitions })),
  );
});

test("every committed shared definition matches its key and every snapshot resolves", () => {
  const definitions = committedDefinitions();
  expect(definitionFailures(definitions)).toEqual([]);
  for (const file of committedContractFiles())
    expect(() => resolveContract(committedContract(file), definitions)).not.toThrow();
});

test("a removed optional Lane field in its shared definition fails every lane action using it", () => {
  const surfaces = contractSurfaces();
  const before = contractSet(surfaces);
  const fields = Object.keys(laneSchema.shape);
  const field = Object.entries(laneSchema.shape).find(([, schema]) => schema.isOptional())?.[0];
  if (!field) throw new Error("Lane has no optional field");
  const laneKeys = Object.keys(before.definitions).filter((key) => {
    const resolved = resolveContract({ $ref: `definitions.json#/${key}` }, before.definitions);
    const properties = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .safeParse(resolved);
    return (
      properties.success &&
      JSON.stringify(Object.keys(properties.data.properties)) === JSON.stringify(fields)
    );
  });
  expect(laneKeys).toHaveLength(1);
  const lane = JSON.stringify(
    resolveContract({ $ref: `definitions.json#/${laneKeys[0]}` }, before.definitions),
  );
  const withoutField = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(withoutField);
    if (typeof node !== "object" || node === null) return node;
    const value = JSON.stringify(node) === lane ? structuredClone(node) : node;
    if (value !== node && "properties" in value && typeof value.properties === "object")
      Reflect.deleteProperty(value.properties ?? {}, field);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        value === node ? withoutField(child) : child,
      ]),
    );
  };
  const after = contractSet(
    surfaces.map(
      (surface): ContractSurface => ({
        ...surface,
        document: () => z.record(z.string(), z.unknown()).parse(withoutField(surface.document())),
      }),
    ),
  );
  const failing = surfaces.filter((surface) => {
    const file = contractFileName(surface);
    return (
      contractBreakingChanges(
        resolveContract(JSON.parse(before.texts.get(file) ?? ""), before.definitions),
        resolveContract(JSON.parse(after.texts.get(file) ?? ""), after.definitions),
      ).length > 0
    );
  });
  const lanes = surfaces.filter((surface) => surface.name.startsWith("action.lane-"));
  const usingLane = lanes.filter((surface) =>
    JSON.stringify(surface.document()).includes(lane.slice(1, -1)),
  );
  expect(usingLane.map((surface) => surface.name)).toEqual(
    lanes.map((surface) => surface.name).filter((name) => name !== "action.lane-next"),
  );
  expect(failing.map((surface) => surface.name)).toEqual(usingLane.map((surface) => surface.name));
  for (const surface of usingLane)
    expect(
      JSON.stringify(JSON.parse(before.texts.get(contractFileName(surface)) ?? "")),
    ).not.toContain(lane.slice(1, -1));
});

test("unresolved, cyclic and tampered shared definitions fail closed", () => {
  const ref = (key: string) => ({ $ref: `definitions.json#/${key}` });
  expect(() => resolveContract(ref("missing"), {})).toThrow("definition missing is missing");
  expect(() => resolveContract(ref("a"), { a: ref("b"), b: ref("a") })).toThrow("refers to itself");
  const { definitions } = contractSet(contractSurfaces());
  const [key] = Object.keys(definitions);
  if (!key) throw new Error("no shared definitions");
  expect(definitionFailures({ ...definitions, [key]: { type: "string" } })).toEqual([
    `definitions.json#/${key}: content does not match its key`,
  ]);
  expect(breakingChanges(name, { $ref: "other.json#/x" })).toEqual([
    "$: unclassified change to $ref",
  ]);
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
    const snapshot = resolveContract(committedContract(file), committedDefinitions());
    expect(z.object({ input: z.unknown() }).parse(snapshot).input).toEqual(tool.inputSchema);
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

  test("tuple items compare by position: input enums may widen, never narrow or reshape", () => {
    const tuple = (values: string[]) => ({
      type: "array",
      prefixItems: [{ type: "string", enum: values }, name],
    });
    expect(breakingChanges(tuple(["a"]), tuple(["a", "b"]))).toEqual([]);
    expect(breakingChanges(tuple(["a", "b"]), tuple(["a"]))).toEqual([
      '$[0]: enum value "b" removed',
    ]);
    expect(
      breakingChanges(tuple(["a"]), { type: "array", prefixItems: [name] }).length,
    ).toBeGreaterThan(0);
    expect(
      contractBreakingChanges({ output: tuple(["a"]) }, { output: tuple(["a", "b"]) }).length,
    ).toBeGreaterThan(0);
  });

  test("input union alternatives can be reordered or prepended", () => {
    const a = object({ kind: { const: "a" } }, ["kind"]);
    const b = object({ kind: { const: "b" } }, ["kind"]);
    const c = object({ kind: { const: "c" } }, ["kind"]);
    expect(breakingChanges({ anyOf: [a, b] }, { anyOf: [c, b, a] })).toEqual([]);
    expect(breakingChanges({ oneOf: [a, b] }, { oneOf: [a, b, {}] }).length).toBeGreaterThan(0);
    expect(
      breakingChanges({ oneOf: [a, b] }, { oneOf: [b, { anyOf: [a] }] }).length,
    ).toBeGreaterThan(0);
  });

  test("a union branch edit is attributed by the separating discriminator", () => {
    const branch = (kind: string, value: Record<string, unknown>) =>
      object({ version: { const: 1 }, kind: { const: kind }, ...value }, ["version", "kind"]);
    expect(
      breakingChanges(
        { oneOf: [branch("a", {}), branch("b", { name })] },
        { oneOf: [branch("a", {}), branch("b", {})] },
      ),
    ).toEqual(["$|1.name: removed"]);
  });

  test("a discriminated oneOf compares branches by discriminator", () => {
    const ok = (value: Record<string, unknown>) =>
      object({ ok: { type: "boolean", const: true }, ...value }, ["ok"]);
    const refused = object({ ok: { type: "boolean", const: false }, code: name }, ["ok", "code"]);
    const output = (value: Record<string, unknown>) => ({
      output: { oneOf: [ok(value), refused] },
    });
    expect(contractBreakingChanges(output({ name }), output({ name, note: name }))).toEqual([]);
    expect(
      breakingChanges(
        { oneOf: [ok({ name }), refused] },
        { oneOf: [refused, ok({ name, note: name })] },
      ),
    ).toEqual([]);
    expect(contractBreakingChanges(output({ name, note: name }), output({ name }))).toContain(
      "output|0.note: removed",
    );
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
