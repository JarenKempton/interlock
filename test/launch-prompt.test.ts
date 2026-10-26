import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { jiraDescription } from "../src/adapters/trackers/jira.ts";
import {
  configurationVersion,
  loadConfigurationInstructions,
  parseProjectToml,
} from "../src/configuration/files.ts";
import { INITIAL_CONFIGURATION } from "../src/configuration/project-files.ts";
import { resolveProjectConfiguration } from "../src/configuration/schema.ts";
import { mapRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { Ticket, TicketKind } from "../src/domain/model.ts";
import { acceptanceCriteria, buildLaunchPrompt } from "../src/execution/launch-prompt.ts";

const fakePlanningTicket: Ticket = {
  ref: ticketRefSchema.parse("jira:example:TEST:ticket:TEST-491"),
  map: mapRefSchema.parse("jira:example:TEST:map:TEST-470"),
  kind: "task",
  state: "open",
  status: "To Do",
  order: 0,
  title: "Carry complete ticket context",
  description:
    "OUTCOME\nBuild inspectable configuration.\n\nVERIFY (all must pass)\n- Prompt contains ticket title and description.\n\nRULES\nUse fake tracker input only.",
};

test.each<TicketKind>(["task", "research", "prototype", "decision"])(
  "%s guidance requests evidence without granting completion authority or choosing a workflow",
  (kind) => {
    const prompt = buildLaunchPrompt({ ...fakePlanningTicket, kind });
    expect(prompt).toContain(
      "Report acceptance evidence, unverified criteria, and remaining blockers.",
    );
    expect(prompt).toContain(
      "does not grant authority to mutate tracker state, close tickets, or update maps",
    );
    expect(prompt).toContain("Passing acceptance checks alone does not authorize completion");
    expect(prompt).toContain("all configured completion gates and required human approvals");
    expect(prompt).not.toContain("resolution comment");
    expect(prompt).not.toContain("append exactly one map context pointer");
    expect(prompt).not.toContain("close only after acceptance is verified");
    expect(prompt).not.toMatch(/pull request|\bPR\b|merge/i);
  },
);

test("project completion gates survive alongside passing acceptance evidence", () => {
  const workflow =
    "Completion gate: Jaren must approve and merge the implementation. Keep the ticket open until then.";
  const prompt = buildLaunchPrompt(fakePlanningTicket, { roleTemplate: workflow });
  expect(prompt).toContain(`Role guidance:\n${workflow}`);
  expect(prompt).toContain("Passing acceptance checks alone does not authorize completion");
  expect(prompt).toContain(z.string().parse(fakePlanningTicket.description));
});

test("prompt carries the entire title, description, and VERIFY context", () => {
  const prompt = buildLaunchPrompt(fakePlanningTicket);
  expect(prompt).toContain(z.string().parse(fakePlanningTicket.title));
  expect(prompt).toContain(z.string().parse(fakePlanningTicket.description));
  expect(prompt).toContain("Acceptance criteria:\n- Prompt contains ticket title");
  expect(prompt).toContain("Role:\ntask");
});

test.each([
  "## Acceptance criteria",
  "AC:",
  "**Acceptance Criteria**",
  "VERIFY (all must pass; paste output in the PR)",
  "h2. Acceptance Criteria",
])("extracts acceptance section headed %s", (heading) => {
  expect(acceptanceCriteria(`Description\n${heading}\n- One\n- Two\n\nRULES\nKeep scope`)).toBe(
    "- One\n- Two",
  );
});

test("explicit acceptance field takes precedence; absent content is reported honestly", () => {
  const prompt = buildLaunchPrompt({ ...fakePlanningTicket, acceptanceCriteria: "Explicit AC" });
  expect(prompt).toContain("Acceptance criteria:\nExplicit AC");
  expect(prompt).toContain(z.string().parse(fakePlanningTicket.description));
  const { title: _title, description: _description, ...legacy } = fakePlanningTicket;
  expect(buildLaunchPrompt(legacy)).toContain("Not supplied by tracker");
  expect(buildLaunchPrompt(legacy)).not.toContain("/Users/");
});

test("ADF description preserves paragraph, list, code, hard break and link content", () => {
  const text = (text: string) => ({ type: "text", text });
  const value = {
    type: "doc",
    version: 1,
    content: [
      { type: "heading", content: [text("Acceptance Criteria")] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [text("First"), { type: "hardBreak" }, text("continued")],
              },
            ],
          },
        ],
      },
      { type: "codeBlock", content: [text("bun test")] },
      {
        type: "paragraph",
        content: [
          {
            ...text("Evidence"),
            marks: [{ type: "link", attrs: { href: "https://example.com/evidence" } }],
          },
        ],
      },
    ],
  };
  expect(jiraDescription(value)).toBe(
    "# Acceptance Criteria\nFirst\ncontinued\n\n```\nbun test\n```\nEvidence (https://example.com/evidence)",
  );
  expect(jiraDescription(null)).toBeUndefined();
  expect(() => jiraDescription({ type: "doc", content: "bad" })).toThrow(
    "Invalid Jira description",
  );
});

test("configured instruction paths are loaded read-only, versioned, and used in the prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wf-instructions-"));
  try {
    const path = join(cwd, "interlock.toml");
    const content = `${INITIAL_CONFIGURATION}\n[instructions]\nruntime_contract = "contract.md"\n[instructions.role_templates]\ntask = "task.md"`;
    writeFileSync(path, content);
    writeFileSync(join(cwd, "contract.md"), "Runtime guidance");
    const workflow =
      "Implement exactly this task; report evidence. Completion requires human merge approval; keep the ticket open pending approval.";
    writeFileSync(join(cwd, "task.md"), workflow);
    const configuration = resolveProjectConfiguration(
      parseProjectToml(content),
      {},
      { path, version: configurationVersion(content) },
    );
    const before = readdirSync(cwd).map((file) => [file, readFileSync(join(cwd, file), "utf8")]);
    const instructions = loadConfigurationInstructions(configuration, "task");
    const prompt = buildLaunchPrompt(fakePlanningTicket, {
      runtimeContract: z.string().parse(instructions.runtimeContract?.resolvedPath),
      roleTemplate: z.string().parse(instructions.roleTemplate?.content),
    });
    expect(prompt).toContain(join(cwd, "contract.md"));
    expect(prompt).toContain(`Role guidance:\n${workflow}`);
    expect(prompt).toContain("Passing acceptance checks alone does not authorize completion");
    expect(instructions.runtimeContract?.version).toBe(configurationVersion("Runtime guidance"));
    expect(readdirSync(cwd).map((file) => [file, readFileSync(join(cwd, file), "utf8")])).toEqual(
      before,
    );
    writeFileSync(join(cwd, "task.md"), "Updated guidance");
    const updated = loadConfigurationInstructions(configuration, "task");
    expect(updated.roleTemplate?.version).not.toBe(instructions.roleTemplate?.version);
    expect(prompt).toContain("Implement exactly this task");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("nested acceptance headings and fenced commands stay inside the acceptance section", () => {
  const criteria =
    "### Required behavior\n- Keep the workspace\n```sh\n# comment\nVERIFY\n```\n### Recovery\n- Retry explicitly";
  expect(acceptanceCriteria(`## Acceptance criteria\n${criteria}\n## Notes\nOther notes`)).toBe(
    criteria,
  );
});

test("Jira mentions, smart links and unsupported nodes remain visible in launch context", () => {
  const description = jiraDescription({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Acceptance criteria" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Ask " },
          { type: "mention", attrs: { id: "fake-owner", text: "@Owner" } },
          { type: "text", text: " to approve " },
          { type: "inlineCard", attrs: { url: "https://example.com/spec" } },
        ],
      },
      { type: "blockCard", attrs: { url: "https://example.com/evidence" } },
      { type: "unknownExtension" },
    ],
  });
  expect(description).toContain("Ask @Owner to approve https://example.com/spec");
  expect(description).toContain("https://example.com/evidence");
  expect(description).toContain("[Unsupported Jira content]");
  const prompt = buildLaunchPrompt({ ...fakePlanningTicket, description });
  expect(prompt).toContain("Acceptance criteria:\nAsk @Owner to approve https://example.com/spec");
});
