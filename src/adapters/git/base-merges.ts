import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MergeProof } from "../../domain/lane/lifecycle.ts";
import type { GitCommandExecutor } from "./workspace.ts";

export async function onlyBaseMerges(
  git: GitCommandExecutor,
  path: string,
  approved: string,
  proof: MergeProof,
): Promise<"yes" | "no" | "unverifiable"> {
  if (!proof.commit) return "no";
  const run = (...args: string[]) => git.run(["git", "--no-replace-objects", ...args], path);
  const read = async (...args: string[]) => {
    const result = await run(...args);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim());
    return result.stdout.trim();
  };
  const holds = async (...args: string[]) => {
    const result = await run(...args);
    if (result.exitCode > 1) throw new Error(result.stderr.trim());
    return result.exitCode === 0;
  };
  try {
    if (process.env.GIT_GRAFT_FILE) return "unverifiable";
    if ((await read("rev-parse", "--is-shallow-repository")) === "true") return "unverifiable";
    if (existsSync(resolve(path, await read("rev-parse", "--git-path", "info/grafts"))))
      return "unverifiable";
    for (const commit of [proof.commit, proof.head])
      if ((await run("cat-file", "-e", `${commit}^{commit}`)).exitCode !== 0)
        await read("fetch", "--quiet", "origin", commit);
    const base = await read("rev-parse", "--verify", `${proof.commit}^1`);
    if (!(await holds("merge-base", "--is-ancestor", approved, proof.head))) return "no";
    const added = await read("rev-list", "--parents", proof.head, `^${approved}`, `^${base}`);
    for (const line of added.split("\n").filter(Boolean)) {
      const [commit, first, second, ...rest] = line.split(" ");
      if (!commit || !first || !second || rest.length) return "no";
      if (!(await holds("merge-base", "--is-ancestor", second, base))) return "no";
      const merged = await run("merge-tree", "--write-tree", first, second);
      if (merged.exitCode === 1) return "no";
      if (merged.exitCode !== 0) throw new Error(merged.stderr.trim());
      if (merged.stdout.split("\n")[0] !== (await read("rev-parse", `${commit}^{tree}`)))
        return "no";
    }
    return "yes";
  } catch {
    return "unverifiable";
  }
}
