import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const baselinePath = "tooling/lint-baseline.json";
const portable = (path) => path.split(sep).join("/");

export function baselineGrowth(current, previous) {
  const added = [];
  for (const group of ["violations", "folders"]) {
    for (const [key, entries] of Object.entries(current[group])) {
      for (const entry of entries) {
        if (!previous[group][key]?.includes(entry)) added.push(`${group}: ${key}: ${entry}`);
      }
    }
  }
  return added;
}

export function folderViolations(folder, files, baseline) {
  if (files.length <= 12) return [];
  const allowed = baseline.folders[folder];
  return allowed ? files.filter((file) => !allowed.includes(file)) : files;
}

function folders(root, directory) {
  if (
    !existsSync(resolve(root, directory)) ||
    /^src\/persistence\/migrations(?:\/|$)/.test(directory)
  )
    return [];
  const entries = readdirSync(resolve(root, directory), { withFileTypes: true });
  return [
    [
      directory,
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort(),
    ],
    ...entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => folders(root, `${directory}/${entry.name}`)),
  ];
}

export default {
  meta: { name: "interlock-structure" },
  rules: {
    "folder-budget": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          budget:
            "{{folder}} exceeds 12 handwritten files; {{file}} is not in the baseline. Split by concept instead of extending the baseline.",
        },
      },
      create(context) {
        const root = context.cwd;
        const filename = context.filename;
        if (portable(relative(root, filename)) !== "vite.config.ts") return {};
        return {
          Program(node) {
            for (const [folder, files] of ["src", "test", "scripts", "tooling"].flatMap(
              (directory) => folders(root, directory),
            )) {
              const violations = folderViolations(
                folder,
                files,
                context.settings["structure/baseline"],
              );
              if (violations.length > 0) {
                context.report({
                  node,
                  messageId: "budget",
                  data: { folder, file: `${folder}/${violations[0]}` },
                });
              }
            }
          },
        };
      },
    },
    "baseline-no-growth": {
      meta: { type: "problem", schema: [], messages: { invalid: "{{message}}" } },
      create(context) {
        if (portable(relative(context.cwd, context.filename)) !== "vite.config.ts") return {};
        return {
          Program(node) {
            const baseline = context.settings["structure/baseline"];
            const report = (message) =>
              context.report({ node, messageId: "invalid", data: { message } });
            for (const files of Object.values(baseline.violations)) {
              for (const file of files) {
                if (!existsSync(resolve(context.cwd, file)))
                  report(`Remove missing baseline file: ${file}`);
              }
            }
            for (const [folder, files] of Object.entries(baseline.folders)) {
              for (const file of files) {
                if (!existsSync(resolve(context.cwd, folder, file)))
                  report(`Remove missing baseline member: ${folder}/${file}`);
              }
            }
            const ref = process.env.INTERLOCK_LINT_BASE || "HEAD";
            try {
              const paths = execFileSync(
                "git",
                ["ls-tree", "--name-only", ref, "--", baselinePath, "biome.json"],
                { cwd: context.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
              )
                .trim()
                .split("\n");
              if (!paths.includes(baselinePath)) {
                if (!paths.includes("biome.json"))
                  report(`Baseline missing at ${ref}; cannot verify shrink-only exemptions.`);
                return;
              }
              const previous = JSON.parse(
                execFileSync("git", ["show", `${ref}:${baselinePath}`], {
                  cwd: context.cwd,
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "pipe"],
                }),
              );
              for (const entry of baselineGrowth(baseline, previous))
                report(`Baseline may only shrink: ${entry}`);
            } catch (error) {
              report(`Cannot verify baseline against ${ref}: ${error.message}`);
            }
          },
        };
      },
    },
  },
};
