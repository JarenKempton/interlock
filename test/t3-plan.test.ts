import { expect, test } from "bun:test";
import {
  resolveProjectConfiguration,
  validateProjectConfiguration,
} from "../src/configuration/schema.ts";
import { planT3Models, validateT3Catalog } from "../src/execution/t3-plan.ts";
import { catalogEnvelope } from "./fixtures/pickup-runtime.ts";

function configuration(extra = {}) {
  return resolveProjectConfiguration(
    validateProjectConfiguration({
      version: 1,
      repositories: {},
      maps: {},
      tracker: { jira: { site: "https://example.atlassian.net" } },
      defaults: { host: "t3", agent: "codex", model: "test-model", effort: "low" },
      ...extra,
    }),
    {},
    { path: "/project/interlock.toml", version: "fixture" },
  );
}

test("an explicit implementer option overrides a default while requirements reject conflicts", () => {
  const roles = {
    implementer: { provider: "codex", model: "test-model", options: { reasoningEffort: "high" } },
  };
  const catalog = validateT3Catalog(catalogEnvelope());
  expect(planT3Models(configuration({ roles }), catalog).implementer.options).toEqual({
    reasoningEffort: "high",
  });
  expect(() =>
    planT3Models(configuration({ roles, required: { effort: "low" } }), catalog),
  ).toThrow("conflicts with required effort");
});

test("required model restrictions apply to reviewer lenses", () => {
  const roles = { reviewers: { correctness: { provider: "codex", model: "other-model" } } };
  const raw = catalogEnvelope();
  const provider = raw.catalog.providers[0];
  if (!provider) throw new Error("Missing fixture provider");
  provider.models.push({ id: "other-model", options: [] });
  expect(() =>
    planT3Models(
      configuration({ roles, required: { model: "test-model" } }),
      validateT3Catalog(raw),
    ),
  ).toThrow("reviewer correctness conflicts with required model");
});

test("project requirements override inherited host defaults", () => {
  expect(
    planT3Models(
      configuration({ required: { effort: "low" } }),
      validateT3Catalog(catalogEnvelope()),
    ).implementer.options,
  ).toEqual({ reasoningEffort: "low" });
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
    planT3Models(
      configuration({
        defaults: { host: "t3", agent: "codex", model: "test-model", context_window: "large" },
      }),
      validateT3Catalog(raw),
    ),
  ).toThrow("cannot verify context_window");
  raw.catalog.runtimeMode = "approval-required";
  expect(() =>
    planT3Models(
      configuration({
        defaults: { host: "t3", agent: "codex", model: "test-model", runtime_mode: "full-access" },
      }),
      validateT3Catalog(raw),
    ),
  ).toThrow("exceed the calling thread");
});
