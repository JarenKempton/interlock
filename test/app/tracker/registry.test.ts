import { expect, test } from "bun:test";
import { configuredTracker } from "../../../src/app/tracker/registry.ts";
import { parseProjects } from "../../../src/app/supervisor/commands.ts";

const both = { jira_site: "https://example.atlassian.net", github_repo: "octo-org/repo" };

test("with Jira and GitHub both set, GH keys go to GitHub and other keys to Jira", () => {
  expect(configuredTracker(both, "GH-42")).toMatchObject({
    entry: { name: "github" },
    site: "octo-org/repo",
  });
  expect(configuredTracker(both, "JWB-42")).toMatchObject({
    entry: { name: "jira" },
    site: "https://example.atlassian.net",
  });
  expect(configuredTracker({ jira_site: both.jira_site }, "GH-42").entry.name).toBe("jira");
  expect(configuredTracker({ github_repo: both.github_repo }, "JWB-42").entry.name).toBe("github");
  expect(configuredTracker({}).entry.name).toBe("jira");
  expect(
    parseProjects("GH-1=/repo/a, JWB-2=/repo/b", both).map((project) => String(project.map)),
  ).toEqual(["github:octo-org.repo:GH:map:GH-1", "jira:example:JWB:map:JWB-2"]);
});
