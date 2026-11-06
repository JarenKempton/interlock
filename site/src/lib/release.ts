import { execFileSync } from "node:child_process";

const releaseTag = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export const currentRelease = () => {
  const tags = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { encoding: "utf8" })
    .split("\n")
    .filter((tag) => releaseTag.test(tag));
  const tag = tags.find((t) => !t.includes("-")) ?? tags[0];
  if (!tag) throw new Error("No release tag found; fetch tags before building the site.");
  return { tag, stable: !tag.includes("-") };
};
