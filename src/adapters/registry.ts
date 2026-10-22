import { type CapabilitySet, capabilities } from "../domain/model.ts";

export type AdapterKind = "tracker" | "workspace";

export interface AdapterDescriptor {
  name: string;
  kind: AdapterKind;
  bundled: boolean;
  available: boolean;
  capabilities: CapabilitySet;
}

export function builtInAdapters(): AdapterDescriptor[] {
  return [
    { name: "jira", kind: "tracker", bundled: true, available: false, capabilities: {} },
    {
      name: "git",
      kind: "workspace",
      bundled: true,
      available: true,
      capabilities: capabilities("workspace_prepare"),
    },
  ];
}

export function findAdapter(name: string): AdapterDescriptor {
  const builtIn = builtInAdapters().find((adapter) => adapter.name === name);
  if (!builtIn) throw new Error(`Adapter not found: ${JSON.stringify(name)}`);
  return builtIn;
}
