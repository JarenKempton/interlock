import { type CapabilitySet, capabilities } from "../domain/model.ts";
import {
  type CommandToken,
  commandHarnessAvailable,
  commandHarnessCapabilities,
  namedHarnessAvailable,
  namedHarnessCapabilities,
  namedHarnesses,
  namedHarnessNameSchema,
} from "./harnesses/command.ts";

export type AdapterKind = "tracker" | "harness" | "workspace" | "environment";

export interface AdapterDescriptor {
  name: string;
  kind: AdapterKind;
  bundled: boolean;
  available: boolean;
  executable?: string;
  capabilities: CapabilitySet;
}

export interface AdapterDiscoveryPlatform {
  which(executable: string): string | null;
  platform: NodeJS.Platform;
}

export interface AdapterRegistryConfiguration {
  command?: { argv: readonly CommandToken[] };
}

const bunDiscoveryPlatform: AdapterDiscoveryPlatform = {
  which: Bun.which,
  platform: process.platform,
};

export function builtInAdapters(
  platform: AdapterDiscoveryPlatform = bunDiscoveryPlatform,
  configuration: AdapterRegistryConfiguration = {},
): AdapterDescriptor[] {
  const trackers = ["jira", "linear", "github", "markdown"].map<AdapterDescriptor>((name) => ({
    name,
    kind: "tracker",
    bundled: true,
    available: false,
    capabilities: {},
  }));

  const namedCommandHarnesses = Object.entries(namedHarnesses).map<AdapterDescriptor>(
    ([key, profile]) => {
      const name = namedHarnessNameSchema.parse(key);
      const executable = profile.argv[0];
      const available = namedHarnessAvailable(name, platform);
      return {
        name,
        kind: "harness",
        bundled: true,
        available,
        ...(executable ? { executable } : {}),
        capabilities: namedHarnessCapabilities(name, platform),
      };
    },
  );
  const commandArgv = configuration.command?.argv;
  const commandExecutable = commandArgv?.[0];
  const harnesses: AdapterDescriptor[] = [
    ...namedCommandHarnesses,
    {
      name: "command",
      kind: "harness",
      bundled: true,
      available: commandHarnessAvailable(commandArgv, platform),
      ...(commandExecutable ? { executable: commandExecutable } : {}),
      capabilities: commandHarnessCapabilities(commandArgv, platform),
    },
    {
      name: "t3",
      kind: "harness",
      bundled: true,
      available: false,
      capabilities: capabilities(),
    },
  ];

  return [
    ...trackers,
    ...harnesses,
    {
      name: "git",
      kind: "workspace" as const,
      bundled: true,
      available: true,
      capabilities: capabilities("workspace_prepare"),
    },
  ].toSorted((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind.localeCompare(right.kind),
  );
}

export function findAdapter(name: string): AdapterDescriptor {
  const builtIn = builtInAdapters().find((adapter) => adapter.name === name);
  if (builtIn) return builtIn;
  const executable = Bun.which(`interlock-adapter-${name}`);
  if (!executable) throw new Error(`Adapter not found: ${JSON.stringify(name)}`);
  return {
    name,
    kind: "tracker",
    bundled: false,
    available: true,
    executable,
    capabilities: {},
  };
}
