import { z } from "zod";
import type { ResolvedConfiguration, ReviewChoices } from "../configuration/schema.ts";

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

export type T3Catalog = z.infer<typeof catalogSchema>;

export function validateT3Catalog(value: unknown, now = new Date()): T3Catalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) throw new Error("A fresh in-thread T3 catalog is required");
  const age = now.getTime() - Date.parse(parsed.data.observedAt);
  if (age < 0 || age > 60_000)
    throw new Error("T3 catalog is stale or future-dated; query the host again");
  return parsed.data;
}

export function planT3Models(
  configuration: ResolvedConfiguration,
  input: T3Catalog,
  review: ReviewChoices = { lenses: [] },
) {
  const { settings } = configuration;
  if (settings.host !== "t3") throw new Error("Requested host is unavailable; pickup supports T3");
  const catalog = input.catalog;
  const runtimeMode = settings.runtime_mode ?? catalog.runtimeMode;
  const interactionMode = settings.interaction_mode ?? catalog.interactionMode;
  const permissions = ["approval-required", "auto-accept-edits", "auto", "full-access"];
  if (
    permissions.indexOf(runtimeMode) > permissions.indexOf(catalog.runtimeMode) ||
    (catalog.interactionMode === "plan" && interactionMode !== "plan")
  )
    throw new Error("Requested T3 modes exceed the calling thread's modes");
  const implementer = selectModel(catalog, runtimeMode, "implementer", {
    agent: settings.agent ?? catalog.inheritedProviderInstanceId,
    model: settings.model ?? catalog.inheritedModel,
    effort: settings.effort,
    context_window: settings.context_window,
  });
  const lenses = review.lenses;
  const reviewer =
    lenses.length === 0 ||
    (review.agent === undefined && review.model === undefined && review.effort === undefined)
      ? implementer
      : selectModel(catalog, runtimeMode, "reviewer", {
          agent: review.agent ?? implementer.instanceId,
          model: review.model ?? implementer.model,
          effort: review.effort,
          context_window: undefined,
        });
  const reviewers = Object.fromEntries(lenses.map((lens) => [lens, reviewer]));
  return { implementer, reviewers, runtimeMode, interactionMode };
}

function selectModel(
  catalog: T3Catalog["catalog"],
  runtimeMode: string,
  role: "implementer" | "reviewer",
  choice: {
    agent: string | null;
    model: string | null;
    effort: string | undefined;
    context_window: string | undefined;
  },
) {
  const providers = catalog.providers.filter((p) => p.providerInstanceId === choice.agent);
  const provider = providers[0];
  if (providers.length !== 1 || !provider?.canRunChildTask || provider.constraints.length)
    throw new Error(`T3 provider is missing, ambiguous, or unavailable for ${role}`);
  const models = provider.models.filter((m) => m.id === choice.model);
  const model = models[0];
  if (models.length !== 1 || !model)
    throw new Error(
      `T3 model is missing or ambiguous for ${role}; query the live catalog with search`,
    );
  if (provider.runtimeModes && !provider.runtimeModes.includes(runtimeMode))
    throw new Error(`T3 runtime mode is unsupported for ${role}`);
  const options: Record<string, string | boolean> =
    choice.agent === catalog.inheritedProviderInstanceId && model.id === catalog.inheritedModel
      ? Object.fromEntries((catalog.inheritedOptions ?? []).map((o) => [o.id, o.value]))
      : {};
  for (const [setting, names] of [
    ["effort", ["reasoningEffort", "effort", "thinking"]],
    ["context_window", ["contextWindow", "context_window"]],
  ] as const) {
    const value = choice[setting];
    if (value === undefined) continue;
    const descriptors = (model.options ?? []).filter((o) => names.some((name) => name === o.id));
    const descriptor = descriptors[0];
    if (descriptors.length !== 1 || !descriptor)
      throw new Error(`T3 cannot verify ${setting} for ${role}`);
    options[descriptor.id] = value;
  }
  for (const [key, value] of Object.entries(options)) {
    const descriptors = (model.options ?? []).filter((o) => o.id === key);
    if (descriptors.length !== 1 || !descriptors[0]?.values.includes(value))
      throw new Error(`T3 model option is unavailable for ${role}`);
  }
  return {
    provider: provider.driverKind,
    instanceId: provider.providerInstanceId,
    model: model.id,
    options,
  };
}
