import { type T3Catalog } from "../adapters/hosts/t3.ts";
import type { ResolvedConfiguration, ReviewChoices } from "../configuration/schema.ts";
export { validateT3Catalog } from "../adapters/hosts/t3.ts";

export function planT3Models(
  configuration: ResolvedConfiguration,
  input?: T3Catalog,
  review: ReviewChoices = { lenses: [] },
) {
  const { settings } = configuration;
  if (settings.host !== "t3") throw new Error("Requested host is unavailable; pickup supports T3");
  if (!input) {
    const explicit = [
      settings.harness,
      settings.model,
      settings.effort,
      settings.context_window,
      settings.runtime_mode,
      settings.interaction_mode,
      review.harness,
      review.model,
      review.effort,
    ];
    if (explicit.some((value) => value !== undefined) || review.lenses.length)
      throw new Error(
        "t3_catalog_required: Explicit harness, model, mode or reviewer settings require a fresh --t3-catalog",
      );
    return {
      implementer: undefined,
      reviewers: {},
      runtimeMode: undefined,
      interactionMode: undefined,
    };
  }
  const catalog = input.catalog;
  const runtimeMode = settings.runtime_mode ?? catalog.runtimeMode;
  const interactionMode = settings.interaction_mode ?? catalog.interactionMode;
  const permissions = ["approval-required", "auto-accept-edits", "auto", "full-access"];
  if (
    permissions.indexOf(runtimeMode) > permissions.indexOf(catalog.runtimeMode) ||
    (catalog.interactionMode === "plan" && interactionMode !== "plan")
  )
    throw new Error("Requested T3 modes exceed the calling session's modes");
  const implementer = selectModel(catalog, runtimeMode, "implementer", {
    harness: settings.harness ?? catalog.inheritedHarnessInstanceId,
    model: settings.model ?? catalog.inheritedModel,
    effort: settings.effort,
    context_window: settings.context_window,
  });
  const lenses = review.lenses;
  const reviewer =
    lenses.length === 0 ||
    (review.harness === undefined && review.model === undefined && review.effort === undefined)
      ? implementer
      : selectModel(catalog, runtimeMode, "reviewer", {
          harness: review.harness ?? implementer.instanceId,
          model: review.model ?? implementer.model,
          effort: review.effort,
          context_window: undefined,
        });
  const reviewers = Object.fromEntries(lenses.map((lens) => [lens, reviewer]));
  return { implementer, reviewers, runtimeMode, interactionMode };
}

export function planHostLaunchModels(
  configuration: ResolvedConfiguration,
  review: ReviewChoices = { lenses: [] },
) {
  const { settings } = configuration;
  if (settings.host !== "t3") throw new Error("Requested host is unavailable; pickup supports T3");
  const unbindable = [
    settings.effort,
    settings.context_window,
    settings.runtime_mode,
    settings.interaction_mode,
    review.harness,
    review.model,
    review.effort,
  ];
  if (unbindable.some((value) => value !== undefined) || review.lenses.length)
    throw new Error(
      "host_unsupported: t3 thread start binds only the harness and model; unset effort, context_window, modes and reviewers, or launch through T3",
    );
  if ((settings.harness === undefined) !== (settings.model === undefined))
    throw new Error("host_unsupported: --launch needs both harness and model, or neither");
  const reviewers: Record<string, ReturnType<typeof selectModel>> = {};
  return {
    implementer:
      settings.harness && settings.model
        ? {
            harness: settings.harness,
            instanceId: settings.harness,
            model: settings.model,
            options: {},
          }
        : undefined,
    reviewers,
    runtimeMode: undefined,
    interactionMode: undefined,
  };
}

function selectModel(
  catalog: T3Catalog["catalog"],
  runtimeMode: string,
  role: "implementer" | "reviewer",
  choice: {
    harness: string | null;
    model: string | null;
    effort: string | undefined;
    context_window: string | undefined;
  },
) {
  const harnesses = catalog.harnesses.filter((p) => p.instanceId === choice.harness);
  const selectedHarness = harnesses[0];
  if (
    harnesses.length !== 1 ||
    !selectedHarness?.canRunChildTask ||
    selectedHarness.constraints.length
  )
    throw new Error(`T3 harness is missing, ambiguous, or unavailable for ${role}`);
  const models = selectedHarness.models.filter((m) => m.id === choice.model);
  const model = models[0];
  if (models.length !== 1 || !model)
    throw new Error(
      `T3 model is missing or ambiguous for ${role}; query the live catalog with search`,
    );
  if (selectedHarness.runtimeModes && !selectedHarness.runtimeModes.includes(runtimeMode))
    throw new Error(`T3 runtime mode is unsupported for ${role}`);
  const options: Record<string, string | boolean> =
    choice.harness === catalog.inheritedHarnessInstanceId && model.id === catalog.inheritedModel
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
    harness: selectedHarness.harness,
    instanceId: selectedHarness.instanceId,
    model: model.id,
    options,
  };
}
