import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import structure, { baselineGrowth, folderViolations } from "../../tooling/structure.mjs";
import { readBaseline } from "../../tooling/baseline.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const empty = { violations: {}, folders: {} };
const temporary = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "interlock-lint-"));
  temporary.push(path);
  return path;
}

function write(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("structure baseline", () => {
  test("allows deletion but rejects new files, rules, and folder members", () => {
    const previous = {
      violations: { "import/no-cycle": ["src/old.ts"] },
      folders: { test: ["old.ts"] },
    };
    expect(baselineGrowth(empty, previous)).toEqual([]);
    expect(baselineGrowth(previous, empty)).toHaveLength(2);
    expect(
      baselineGrowth({ ...previous, violations: { "no-unused-vars": ["src/old.ts"] } }, previous),
    ).toEqual(["violations: no-unused-vars: src/old.ts"]);
  });

  test("caps unlisted folders at twelve and freezes oversized folder membership", () => {
    const files = Array.from({ length: 12 }, (_, index) => `file-${index}.ts`);
    expect(folderViolations("src/domain", files, empty)).toEqual([]);
    expect(folderViolations("src/domain", [...files, "extra.ts"], empty)).toHaveLength(13);
    const oversized = [...files, "legacy.ts"];
    const baseline = { violations: {}, folders: { "src/domain": oversized } };
    expect(folderViolations("src/domain", oversized, baseline)).toEqual([]);
    expect(folderViolations("src/domain", [...oversized, "extra.json"], baseline)).toEqual([
      "extra.json",
    ]);
    expect(folderViolations("src/domain", [...files.slice(1), "replacement.ts"], baseline)).toEqual(
      [],
    );
  });

  test("reads the Git base and rejects growth, missing files, and unreadable refs", () => {
    const cwd = directory();
    execFileSync("git", ["init", "--quiet", cwd]);
    write(cwd, "tooling/lint-baseline.json", JSON.stringify(empty));
    write(cwd, "src/extra.ts", "export {};\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
      { cwd },
    );
    const reports = [];
    const baseline = {
      violations: { "import/no-cycle": ["src/extra.ts", "src/missing.ts"] },
      folders: {},
    };
    const context = {
      cwd,
      filename: join(cwd, "vite.config.ts"),
      settings: {
        "structure/baseline": baseline,
        "structure/comparison": readBaseline(cwd, "HEAD"),
      },
      report: (report) => reports.push(report.data.message),
    };
    structure.rules["baseline-no-growth"].create(context).Program({});
    expect(reports).toContain("Remove missing baseline file: src/missing.ts");
    expect(reports).toContain(
      "Baseline may only shrink: violations: import/no-cycle: src/extra.ts",
    );
    reports.length = 0;
    context.settings["structure/comparison"] = readBaseline(cwd, "missing-ref");
    structure.rules["baseline-no-growth"].create(context).Program({});
    expect(reports.join("\n")).toContain("Cannot verify baseline against missing-ref");
  });
});

test("vp lint rejects a misplaced file, forbidden imports, cycles, naming, and a thirteenth file", async () => {
  const cwd = directory();
  symlinkSync(
    resolve(root, "node_modules"),
    join(cwd, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  write(
    cwd,
    "package.json",
    JSON.stringify({ type: "module", devDependencies: { "vite-plus": "1.5.0" } }),
  );
  write(
    cwd,
    "vite.config.ts",
    `import original from ${JSON.stringify(pathToFileURL(join(root, "vite.config.ts")).href)};
export default { ...original, lint: { ...original.lint, options: { typeAware: true, typeCheck: false }, overrides: [], jsPlugins: ["eslint-plugin-boundaries", { name: "structure", specifier: ${JSON.stringify(join(root, "tooling/structure.mjs"))} }], rules: { ...original.lint.rules, "structure/baseline-no-growth": "off" }, settings: { ...original.lint.settings, "structure/baseline": { violations: {}, folders: {} } } } };\n`,
  );
  write(
    cwd,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, target: "ES2024", module: "Preserve", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  write(
    cwd,
    "src/domain/claim/strict.ts",
    "export type Explicit = any; export function nonNull(value: string | undefined) { return value!; } export const unsafe = ({} as unknown) as { value: string };\n",
  );
  write(cwd, "src/misplaced.ts", "export const misplaced = true;\n");
  write(cwd, "src/domain/claim/BadName.ts", "export const bad = true;\n");
  write(
    cwd,
    "src/domain/claim/vendor.ts",
    "import { readFileSync } from 'node:fs'; export { readFileSync };\n",
  );
  write(
    cwd,
    "src/domain/claim/cycle-a.ts",
    "export { cycleB } from './cycle-b'; export const cycleA = true;\n",
  );
  write(
    cwd,
    "src/domain/claim/cycle-b.ts",
    "export { cycleA } from './cycle-a'; export const cycleB = true;\n",
  );
  write(cwd, "src/execution/pickup/run.ts", "export const run = true;\n");
  write(
    cwd,
    "src/adapters/trackers/jira/client.ts",
    "export { run } from '../../../execution/pickup/run';\n",
  );
  for (let index = 0; index < 13; index++) {
    write(cwd, `src/domain/budget/file-${index}.ts`, "export {};\n");
    write(cwd, `test/fixtures/data/file-${index}.json`, "{}\n");
    write(cwd, `src/persistence/migrations/file-${index}.sql`, "SELECT 1;\n");
  }
  const subprocess = Bun.spawn(["vp", "lint", "--format", "json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, status] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  expect(errors).toBe("");
  expect(status).toBe(1);
  const diagnostics = JSON.parse(output).diagnostics;
  for (const code of [
    "boundaries(no-unknown-files)",
    "boundaries(dependencies)",
    "unicorn(filename-case)",
    "import(no-cycle)",
    "structure(folder-budget)",
    "typescript(no-explicit-any)",
    "typescript(no-non-null-assertion)",
    "typescript(no-unsafe-type-assertion)",
  ]) {
    expect(diagnostics.some((diagnostic) => diagnostic.code === code)).toBe(true);
  }
  expect(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.filename === "src/domain/claim/vendor.ts" &&
        diagnostic.code === "boundaries(dependencies)",
    ),
  ).toBe(true);
  expect(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.filename === "src/adapters/trackers/jira/client.ts" &&
        diagnostic.code === "boundaries(dependencies)",
    ),
  ).toBe(true);
  expect(
    diagnostics.filter((diagnostic) => diagnostic.code === "structure(folder-budget)"),
  ).toHaveLength(2);
  for (const file of [
    "src/misplaced.ts",
    "src/domain/claim/strict.ts",
    "src/domain/claim/BadName.ts",
    "src/domain/claim/vendor.ts",
    "src/domain/claim/cycle-a.ts",
    "src/domain/claim/cycle-b.ts",
    "src/adapters/trackers/jira/client.ts",
    "src/domain/budget/file-12.ts",
    "test/fixtures/data/file-12.json",
  ])
    rmSync(join(cwd, file));
  const fixed = Bun.spawn(["vp", "lint", "--format", "json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const fixedOutput = await new Response(fixed.stdout).text();
  const fixedErrors = await new Response(fixed.stderr).text();
  expect(fixedErrors).toBe("");
  expect(JSON.parse(fixedOutput).diagnostics).toEqual([]);
  expect(await fixed.exited).toBe(0);
}, 30000);
