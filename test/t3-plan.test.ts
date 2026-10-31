import { expect, test } from "bun:test";
import { resolveConfiguration, type UserSettings } from "../src/configuration/schema.ts";
import { planT3Models, validateT3Catalog } from "../src/execution/t3-plan.ts";
import { catalogEnvelope } from "./fixtures/pickup-runtime.ts";

function configuration(user: UserSettings = {}) {
  return resolveConfiguration(undefined, user);
}

test("with no user choices the implementer inherits the calling thread's provider, model and options", () => {
  expect(planT3Models(configuration(), validateT3Catalog(catalogEnvelope())).implementer).toEqual({
    provider: "codex",
    instanceId: "codex",
    model: "test-model",
    options: { reasoningEffort: "high" },
  });
});

test("user effort overrides the inherited option", () => {
  expect(
    planT3Models(configuration({ effort: "low" }), validateT3Catalog(catalogEnvelope())).implementer
      .options,
  ).toEqual({ reasoningEffort: "low" });
});

test("a user-chosen model other than the inherited one starts without inherited options", () => {
  const raw = catalogEnvelope();
  raw.catalog.providers[0]?.models.push({ id: "other-model", options: [] });
  expect(
    planT3Models(configuration({ agent: "codex", model: "other-model" }), validateT3Catalog(raw))
      .implementer,
  ).toMatchObject({ model: "other-model", options: {} });
});

test("duplicate model descriptors fail closed even in a unique provider", () => {
  const raw = catalogEnvelope();
  const provider = raw.catalog.providers[0];
  if (!provider?.models[0]) throw new Error("Missing fixture provider");
  provider.models.push(provider.models[0]);
  expect(() => planT3Models(configuration(), validateT3Catalog(raw))).toThrow(
    "missing or ambiguous",
  );
});

test("requested context and permission expansion fail when the host cannot verify them", () => {
  const raw = catalogEnvelope();
  expect(() =>
    planT3Models(configuration({ context_window: "large" }), validateT3Catalog(raw)),
  ).toThrow("cannot verify context_window");
  raw.catalog.runtimeMode = "approval-required";
  expect(() =>
    planT3Models(configuration({ runtime_mode: "full-access" }), validateT3Catalog(raw)),
  ).toThrow("exceed the calling thread");
});
