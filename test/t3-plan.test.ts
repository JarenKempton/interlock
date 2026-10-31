import { expect, test } from "bun:test";
import {
  resolveConfiguration,
  reviewChoicesFrom,
  type UserSettings,
} from "../src/configuration/schema.ts";
import { planT3Models, validateT3Catalog } from "../src/execution/t3-plan.ts";
import { catalogEnvelope } from "./fixtures/pickup-runtime.ts";

function configuration(user: UserSettings = {}) {
  return resolveConfiguration(undefined, user);
}

function review(user: UserSettings, raw = catalogEnvelope()) {
  return planT3Models(configuration(user), validateT3Catalog(raw), reviewChoicesFrom(user))
    .reviewers;
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

test("each configured review lens gets the implementer selection unless reviewer choices are set", () => {
  const raw = catalogEnvelope();
  expect(review({ reviewers: "correctness, security" }, raw)).toEqual({
    correctness: {
      provider: "codex",
      instanceId: "codex",
      model: "test-model",
      options: { reasoningEffort: "high" },
    },
    security: {
      provider: "codex",
      instanceId: "codex",
      model: "test-model",
      options: { reasoningEffort: "high" },
    },
  });
  raw.catalog.providers.push({
    providerInstanceId: "claudeAgent",
    driverKind: "claudeAgent",
    canRunChildTask: true,
    constraints: [],
    models: [{ id: "review-model", options: [{ id: "effort", values: ["medium", "high"] }] }],
  });
  expect(
    review(
      {
        reviewers: "correctness",
        reviewer_agent: "claudeAgent",
        reviewer_model: "review-model",
        reviewer_effort: "high",
      },
      raw,
    ),
  ).toEqual({
    correctness: {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      model: "review-model",
      options: { effort: "high" },
    },
  });
});

test("an unverifiable reviewer fails closed, and reviewer choices without lenses plan none", () => {
  expect(() => review({ reviewers: "correctness", reviewer_model: "missing" })).toThrow(
    "missing or ambiguous for reviewer",
  );
  expect(() => review({ reviewers: "correctness", reviewer_effort: "max" })).toThrow(
    "option is unavailable for reviewer",
  );
  expect(review({ reviewer_model: "missing" })).toEqual({});
});

test("review lenses must be distinct lowercase names", () => {
  for (const reviewers of ["Correctness", "a,a", "has space", ","])
    expect(() => configuration({ reviewers })).toThrow("Invalid configuration");
});
