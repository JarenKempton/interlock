import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lockRecordSchema } from "../adapters/claims/git-lock.ts";
import { claimPropertySchema } from "../adapters/trackers/jira.ts";
import { createApplication } from "../application.ts";
import { registeredActions } from "../cli/catalog.ts";
import {
  personalSettingsSchema,
  projectConfigurationSchema,
  userSettingsSchema,
} from "../configuration/schema.ts";
import { CLAIM_RECORD_VERSION } from "../domain/claim-lock.ts";
import { actionInputSchema } from "../mcp/server.ts";

export const CONTRACTS_DIRECTORY = join(import.meta.dirname, "../../contracts");
export const CONTRACT_HASHES_PATH = join(CONTRACTS_DIRECTORY, "hashes.json");
export const CONTRACT_DEFINITIONS_PATH = join(CONTRACTS_DIRECTORY, "definitions.json");
export const hashesSchema = z.record(z.string(), z.string());
export const definitionsSchema = z.record(z.string(), z.unknown());
export type Definitions = z.infer<typeof definitionsSchema>;
const DEFINITION_REF = "definitions.json#/";
const SHARED_MINIMUM = 400;

export interface ContractSurface {
  name: string;
  version: number;
  frozen: boolean;
  document(): Record<string, unknown>;
}

const identifierAsString: Parameters<typeof z.toJSONSchema>[1] = {
  unrepresentable: "any",
  override: (context) => {
    if (context.zodSchema._zod.def.type === "custom") context.jsonSchema.type = "string";
  },
};

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _schema, ...document } = z.toJSONSchema(schema, { ...identifierAsString, io });
  return document;
}

export function contractSurfaces(): ContractSurface[] {
  const actions = registeredActions(createApplication()).map(({ command, action }) => ({
    name: `action.${command.join("-")}`,
    version: action.version,
    frozen: false,
    document: () => ({
      input: actionInputSchema(action),
      output: jsonSchema(action.result, "output"),
    }),
  }));
  return [
    {
      name: "claim-record",
      version: CLAIM_RECORD_VERSION,
      frozen: true,
      document: () => ({
        version: CLAIM_RECORD_VERSION,
        lockRecord: z.toJSONSchema(lockRecordSchema, identifierAsString),
        jiraClaimProperty: z.toJSONSchema(claimPropertySchema, identifierAsString),
      }),
    },
    {
      name: "interlock-toml",
      version: projectConfigurationSchema.shape.version.unwrap().value,
      frozen: false,
      document: () => ({ file: jsonSchema(projectConfigurationSchema, "input") }),
    },
    {
      name: "user-settings",
      version: 1,
      frozen: false,
      document: () => ({ file: jsonSchema(userSettingsSchema, "input") }),
    },
    {
      name: "personal-settings",
      version: 1,
      frozen: false,
      document: () => ({ file: jsonSchema(personalSettingsSchema, "input") }),
    },
    ...actions,
  ];
}

export function contractFileName(surface: Pick<ContractSurface, "name" | "version">): string {
  return `${surface.name}.v${surface.version}.json`;
}

export function contractText(surface: ContractSurface): string {
  return jsonText(surface.document());
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definitionKey(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.$ref !== "string")
    return undefined;
  return value.$ref.startsWith(DEFINITION_REF)
    ? value.$ref.slice(DEFINITION_REF.length)
    : undefined;
}

function mapTree(value: unknown, visit: (node: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map(visit);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]));
  return value;
}

export function resolveContract(
  document: unknown,
  definitions: Definitions,
  active: string[] = [],
): unknown {
  const key = definitionKey(document);
  if (key === undefined)
    return mapTree(document, (child) => resolveContract(child, definitions, active));
  if (active.includes(key)) throw new Error(`definition ${key} refers to itself`);
  if (!Object.hasOwn(definitions, key)) throw new Error(`definition ${key} is missing`);
  return resolveContract(definitions[key], definitions, [...active, key]);
}

export function definitionFailures(definitions: Definitions): string[] {
  return Object.keys(definitions).flatMap((key) => {
    try {
      const resolved = resolveContract({ $ref: `${DEFINITION_REF}${key}` }, definitions);
      return contentHash(JSON.stringify(resolved)) === key
        ? []
        : [`definitions.json#/${key}: content does not match its key`];
    } catch (error) {
      return [`definitions.json#/${key}: ${error instanceof Error ? error.message : error}`];
    }
  });
}

export function referencedDefinitions(documents: unknown[], definitions: Definitions): Definitions {
  const used: Definitions = {};
  const collect = (node: unknown): unknown => {
    const key = definitionKey(node);
    if (key === undefined) return mapTree(node, collect);
    if (!Object.hasOwn(used, key) && Object.hasOwn(definitions, key)) {
      used[key] = definitions[key];
      collect(definitions[key]);
    }
    return node;
  };
  for (const document of documents) collect(document);
  return Object.fromEntries(Object.entries(used).sort(([a], [b]) => a.localeCompare(b)));
}

export function contractSet(surfaces: ContractSurface[]): {
  texts: Map<string, string>;
  definitions: Definitions;
} {
  const documents = surfaces.map((surface) => surface.document());
  const counts = new Map<string, number>();
  const count = (node: unknown): unknown => {
    if (isRecord(node)) {
      const text = JSON.stringify(node);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return mapTree(node, count);
  };
  surfaces.forEach((surface, index) => {
    if (!surface.frozen) mapTree(documents[index], count);
  });
  const definitions: Definitions = {};
  const share = (node: unknown): unknown => {
    const text = isRecord(node) ? JSON.stringify(node) : "";
    if (text.length < SHARED_MINIMUM || (counts.get(text) ?? 0) < 2) return mapTree(node, share);
    const key = contentHash(text);
    definitions[key] ??= mapTree(node, share);
    return { $ref: `${DEFINITION_REF}${key}` };
  };
  const shared = surfaces.map((surface, index) =>
    surface.frozen ? documents[index] : mapTree(documents[index], share),
  );
  const uses = new Map<string, number>();
  const tally = (node: unknown): unknown => {
    const key = definitionKey(node);
    if (key !== undefined) uses.set(key, (uses.get(key) ?? 0) + 1);
    return mapTree(node, tally);
  };
  for (const node of [...shared, ...Object.values(definitions)]) tally(node);
  const inline = (node: unknown): unknown => {
    const key = definitionKey(node);
    if (key !== undefined && uses.get(key) === 1) return inline(definitions[key]);
    return mapTree(node, inline);
  };
  const documentsWithReferences = shared.map(inline);
  const kept = Object.fromEntries(
    Object.entries(definitions)
      .filter(([key]) => uses.get(key) !== 1)
      .map(([key, value]) => [key, mapTree(value, inline)]),
  );
  return {
    texts: new Map(
      surfaces.map((surface, index) => [
        contractFileName(surface),
        jsonText(documentsWithReferences[index]),
      ]),
    ),
    definitions: referencedDefinitions(documentsWithReferences, kept),
  };
}

export function definitionsText(definitions: Definitions): string {
  return jsonText(definitions);
}

export function committedDefinitions(): Definitions {
  return existsSync(CONTRACT_DEFINITIONS_PATH)
    ? definitionsSchema.parse(JSON.parse(readFileSync(CONTRACT_DEFINITIONS_PATH, "utf8")))
    : {};
}

export function parseContractFileName(file: string): { name: string; version: number } | undefined {
  const match = /^(.+)\.v(\d+)\.json$/.exec(file);
  return match?.[1] && match[2] ? { name: match[1], version: Number(match[2]) } : undefined;
}

export function contractVersionFailures(
  surfaces: Pick<ContractSurface, "name" | "version">[],
  files: string[],
): string[] {
  return surfaces.flatMap(({ name, version }) => {
    if (!Number.isSafeInteger(version) || version < 1)
      return [`${name}: major must be a positive integer`];
    const highest = Math.max(
      0,
      ...files
        .map(parseContractFileName)
        .filter((entry) => entry?.name === name)
        .map((entry) => entry?.version ?? 0),
    );
    return version < highest
      ? [`${name}: major ${version} is below committed major ${highest}`]
      : [];
  });
}

export function committedContractFiles(): string[] {
  return readdirSync(CONTRACTS_DIRECTORY)
    .filter((file) => parseContractFileName(file) !== undefined)
    .sort();
}

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function committedContract(file: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACTS_DIRECTORY, file), "utf8"));
}

export function committedContractDefinitions(available: Definitions): Definitions {
  return referencedDefinitions(committedContractFiles().map(committedContract), available);
}

export function contractHash(file: string): string {
  return contentHash(readFileSync(join(CONTRACTS_DIRECTORY, file)));
}

export function committedContractHashes(): Record<string, string> {
  return existsSync(CONTRACT_HASHES_PATH)
    ? hashesSchema.parse(JSON.parse(readFileSync(CONTRACT_HASHES_PATH, "utf8")))
    : {};
}
