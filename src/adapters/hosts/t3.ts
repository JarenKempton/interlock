import { z } from "zod";

const optionValue = z.union([z.string(), z.boolean()]);
const catalogSchema = z.object({
  host: z.literal("t3"),
  observedAt: z.iso.datetime(),
  catalog: z.object({
    parentThreadId: z.string().min(1),
    inheritedProviderInstanceId: z.string().nullable(),
    inheritedModel: z.string().nullable(),
    inheritedOptions: z.array(z.object({ id: z.string(), value: optionValue })).optional(),
    runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    interactionMode: z.enum(["default", "plan"]),
    features: z.object({ threadManagement: z.literal(true) }),
    providers: z.array(
      z.object({
        providerInstanceId: z.string(),
        driverKind: z.string(),
        canRunChildTask: z.boolean(),
        constraints: z.array(z.string()),
        runtimeModes: z.array(z.string()).optional(),
        models: z.array(
          z.object({
            id: z.string(),
            options: z.array(z.object({ id: z.string(), values: z.array(optionValue) })).nullish(),
          }),
        ),
      }),
    ),
  }),
});

export type T3Catalog = ReturnType<typeof validateT3Catalog>;

export function validateT3Catalog(value: unknown, now = new Date()) {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) throw new Error("A fresh in-thread T3 catalog is required");
  const age = now.getTime() - Date.parse(parsed.data.observedAt);
  if (age < 0 || age > 60_000)
    throw new Error("T3 catalog is stale or future-dated; query the host again");
  const { catalog, ...envelope } = parsed.data;
  return {
    ...envelope,
    catalog: {
      parentSessionId: catalog.parentThreadId,
      inheritedHarnessInstanceId: catalog.inheritedProviderInstanceId,
      inheritedModel: catalog.inheritedModel,
      inheritedOptions: catalog.inheritedOptions,
      runtimeMode: catalog.runtimeMode,
      interactionMode: catalog.interactionMode,
      harnesses: catalog.providers.map(({ providerInstanceId, driverKind, ...entry }) => ({
        ...entry,
        instanceId: providerInstanceId,
        harness: driverKind === "claudeAgent" ? "claude" : driverKind,
      })),
    },
  };
}

export function t3Target(target: {
  instanceId: string;
  model: string;
  options: Record<string, string | boolean>;
}) {
  return { providerInstanceId: target.instanceId, model: target.model, options: target.options };
}
