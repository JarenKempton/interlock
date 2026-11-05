import { defineConfig } from "vite-plus";
import baseline from "./tooling/lint-baseline.json";
import { readBaseline } from "./tooling/baseline.ts";

const comparison = readBaseline(process.cwd(), process.env.INTERLOCK_LINT_BASE || "HEAD");

const layers = [
  "domain",
  "execution",
  "adapters",
  "persistence",
  "cli",
  "mcp",
  "app",
  "configuration",
  "conformance",
  "sign-in",
  "distribution",
];

export default defineConfig({
  run: {
    cache: false,
    tasks: {
      dev: "bun src/cli.ts",
      test: "bun test",
      "test:shard": "bun scripts/test-shard.ts",
      typecheck: "tsc --noEmit",
      check: "vp check",
      format: "vp fmt",
      build: "bun build ./src/cli.ts --compile --outfile ./dist/interlock",
      "build:release": "bun build ./src/cli.ts --compile",
      "release:version": "bun scripts/release-version.ts",
      "db:generate": "drizzle-kit generate",
      "db:check": "bun scripts/verify-migrations.ts",
      "db:hash": "bun scripts/verify-migrations.ts --write",
      "contracts:write": "bun scripts/write-contracts.ts",
      "contracts:check": "bun scripts/check-contracts.ts",
      "sample-ledger": "bun scripts/create-sample-ledger.ts",
      completions: "bun src/cli.ts completions",
      man: "bun src/cli.ts man",
    },
  },
  fmt: {
    singleQuote: false,
    semi: true,
    tabWidth: 2,
    printWidth: 100,
    ignorePatterns: ["site/**", "contracts/**", "src/persistence/migrations/**", "bun.lock"],
  },
  lint: {
    plugins: ["typescript", "unicorn", "import", "oxc"],
    jsPlugins: [
      "eslint-plugin-boundaries",
      { name: "structure", specifier: "./tooling/structure.mjs" },
    ],
    overrides: Object.entries(baseline.violations).map(([rule, files]) => ({
      files,
      rules: { [rule]: "off" },
    })),
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/node_modules/**", "dist/**", "site/**", "src/persistence/migrations/**"],
    categories: { correctness: "error" },
    rules: {
      "structure/folder-budget": "error",
      "structure/baseline-no-growth": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "import/no-cycle": "error",
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          checkAllOrigins: true,
          policies: [
            {
              from: { file: { categories: "entry" } },
              allow: { to: { element: { type: "app" } } },
            },
            { from: { element: { type: "domain" } }, allow: { to: { module: { source: "zod" } } } },
            {
              from: {
                element: {
                  type: [
                    "adapters",
                    "persistence",
                    "cli",
                    "mcp",
                    "app",
                    "configuration",
                    "conformance",
                    "sign-in",
                    "distribution",
                    "entry",
                  ],
                },
              },
              allow: { to: { module: { origin: ["external", "core"] } } },
            },
            {
              from: { element: { type: "domain" } },
              allow: { to: { element: { type: "domain" } } },
            },
            {
              from: { element: { type: "execution" } },
              allow: { to: { element: { type: "domain" } } },
            },
            {
              from: { element: { type: "adapters" } },
              allow: { to: { element: { type: ["domain", "adapters"] } } },
            },
            {
              from: { element: { type: "persistence" } },
              allow: { to: { element: { type: "domain" } } },
            },
            {
              from: { element: { type: ["cli", "mcp"] } },
              allow: { to: { element: { type: ["app", "execution"] } } },
            },
            {
              from: {
                element: {
                  type: ["app", "configuration", "conformance", "sign-in", "distribution", "entry"],
                },
              },
              allow: { to: { element: { type: "*" } } },
            },
          ],
        },
      ],
    },
    settings: {
      "structure/baseline": baseline,
      "structure/comparison": comparison,
      "boundaries/include": ["src/**/*.ts"],
      "boundaries/elements": layers.map((type) => ({ type, pattern: `src/${type}` })),
      "boundaries/files": [{ category: "entry", pattern: "src/main.ts" }],
      "import/resolver": { typescript: { alwaysTryTypes: true }, node: true },
    },
  },
});
