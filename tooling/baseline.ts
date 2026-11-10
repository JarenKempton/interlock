import { execFileSync } from "node:child_process";
import { z } from "zod";

const baselinePath = "tooling/lint-baseline.json";
export const baselineSchema = z.object({
  violations: z.record(z.string(), z.array(z.string())),
  folders: z.record(z.string(), z.array(z.string())),
});

export function readBaseline(cwd: string, ref: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const paths = git(["ls-tree", "--name-only", ref, "--", baselinePath, "biome.json"])
      .trim()
      .split("\n");
    if (paths.includes(baselinePath)) {
      return {
        ref,
        baseline: baselineSchema.parse(JSON.parse(git(["show", `${ref}:${baselinePath}`]))),
      };
    }
    if (paths.includes("biome.json")) return { ref, baseline: null };
    return { ref, error: `Baseline missing at ${ref}; cannot verify shrink-only exemptions.` };
  } catch (error) {
    return {
      ref,
      error: `Cannot verify baseline against ${ref}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
