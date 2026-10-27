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
export const hashesSchema = z.record(z.string(), z.string());

export interface ContractSurface {
  name: string;
  version: number;
  frozen: boolean;
  document(): unknown;
}

const identifierAsString: Parameters<typeof z.toJSONSchema>[1] = {
  unrepresentable: "any",
  override: (context) => {
    if (context.zodSchema._zod.def.type === "custom") context.jsonSchema.type = "string";
  },
};

function fileSchema(schema: z.ZodType): unknown {
  const { $schema: _schema, ...document } = z.toJSONSchema(schema, {
    ...identifierAsString,
    io: "input",
  });
  return document;
}

export function contractSurfaces(): ContractSurface[] {
  const actions = registeredActions(createApplication()).map(({ command, action }) => ({
    name: `action.${command.join("-")}`,
    version: action.version,
    frozen: false,
    document: () => ({ input: actionInputSchema(action) }),
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
      version: projectConfigurationSchema.shape.version.value,
      frozen: false,
      document: () => fileSchema(projectConfigurationSchema),
    },
    {
      name: "user-settings",
      version: 1,
      frozen: false,
      document: () => fileSchema(userSettingsSchema),
    },
    {
      name: "personal-settings",
      version: 1,
      frozen: false,
      document: () => fileSchema(personalSettingsSchema),
    },
    ...actions,
  ];
}

export function contractFileName(surface: Pick<ContractSurface, "name" | "version">): string {
  return `${surface.name}.v${surface.version}.json`;
}

export function contractText(surface: ContractSurface): string {
  return `${JSON.stringify(surface.document(), null, 2)}\n`;
}

export function parseContractFileName(file: string): { name: string; version: number } | undefined {
  const match = /^(.+)\.v(\d+)\.json$/.exec(file);
  return match?.[1] && match[2] ? { name: match[1], version: Number(match[2]) } : undefined;
}

export function committedContractFiles(): string[] {
  return readdirSync(CONTRACTS_DIRECTORY)
    .filter((file) => parseContractFileName(file) !== undefined)
    .sort();
}

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function contractHash(file: string): string {
  return contentHash(readFileSync(join(CONTRACTS_DIRECTORY, file)));
}

export function committedContractHashes(): Record<string, string> {
  return existsSync(CONTRACT_HASHES_PATH)
    ? hashesSchema.parse(JSON.parse(readFileSync(CONTRACT_HASHES_PATH, "utf8")))
    : {};
}
