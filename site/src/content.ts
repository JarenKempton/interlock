import antigravity from "./logos/antigravity.svg?raw";
import ciRunner from "./logos/ci-runner.svg?raw";
import claude from "./logos/claude.svg?raw";
import codex from "./logos/codex.svg?raw";
import conductor from "./logos/conductor.svg?raw";
import cursor from "./logos/cursor.svg?raw";
import docker from "./logos/docker.svg?raw";
import git from "./logos/git.svg?raw";
import github from "./logos/github.svg?raw";
import herdr from "./logos/herdr.svg?raw";
import jira from "./logos/jira.svg?raw";
import laptop from "./logos/laptop.svg?raw";
import linear from "./logos/linear.svg?raw";
import native from "./logos/native.svg?raw";
import opencode from "./logos/opencode.svg?raw";
import pi from "./logos/pi.svg?raw";
import t3code from "./logos/t3code.svg?raw";
import tmux from "./logos/tmux.svg?raw";
import vps from "./logos/vps.svg?raw";
import workstation from "./logos/workstation.svg?raw";

export interface Chip {
  name: string;
  logo: string;
  brand?: string;
  official: boolean;
}

export interface Layer {
  id: string;
  name: string;
  gloss?: string;
  today: Chip[];
  soon: Chip[];
  text?: string;
}

const chip = (name: string, logo: string, brand?: string): Chip =>
  brand ? { name, logo, brand, official: true } : { name, logo, official: false };

export const product = {
  name: "Interlock",
  github: "https://github.com/JarenKempton/interlock",
  releases: "https://github.com/JarenKempton/interlock/releases",
  license: "https://github.com/JarenKempton/interlock/blob/main/LICENSE",
};

export const hero = {
  description:
    "Interlock claims a ticket through a lock on your Git remote, prepares an isolated worktree, and opens exactly one pull request per ticket.",
  drive: {
    title: "You or your agent.",
    body: "Both start the same lane. You review and merge.",
    terminal: { label: "Terminal", text: 'interlock pickup TEST-492 --t3-catalog "$T3_CATALOG"' },
    agent: { label: "Agent, example request", text: "Pick up TEST-492 and open the pull request when it's ready." },
  },
};

const release = "0.1.0-alpha.4";
const releaseUrl = `https://github.com/JarenKempton/interlock/releases/download/v${release}`;

export const install = {
  platforms: [
    {
      id: "unix",
      label: "macOS / Linux",
      command: `curl --proto '=https' --tlsv1.2 -fsSL ${releaseUrl}/install.sh | INTERLOCK_VERSION=${release} sh`,
    },
    {
      id: "windows",
      label: "Windows PowerShell",
      command: `$env:INTERLOCK_VERSION = '${release}'; irm ${releaseUrl}/install.ps1 | iex`,
    },
  ],
};

export const steps = [
  {
    n: 1,
    id: "claim",
    title: "Claim",
    actor: "You or your agent",
    caption: "You pick up TEST-492 from the queue, and Interlock claims it for you on the Git remote.",
  },
  {
    n: 2,
    id: "prepare",
    title: "Prepare",
    actor: "Interlock",
    caption: "Interlock creates a Git worktree on task/TEST-492 from main.",
  },
  {
    n: 3,
    id: "implement",
    title: "Implement",
    actor: "Agent",
    caption: "Your agent writes the change in the worktree, however you run it.",
  },
  {
    n: 4,
    id: "submit",
    title: "Submit",
    actor: "Agent, then you",
    caption:
      "The agent calls lane submit and Interlock opens the one pull request. A reviewer asks for a change, the agent pushes it to the same pull request, and the reviewer approves.",
  },
  {
    n: 5,
    id: "complete",
    title: "Complete",
    actor: "You, then Interlock",
    caption:
      "You merge. lane complete verifies Done in the tracker, closes the lane, and removes the worktree and branch. A dirty tree or an unmerged branch is refused, and nothing is removed.",
  },
] as const;

export const sections = {
  install: "Install",
  soon: "Soon",
};

export const principle = "A repeatable path from ticket to done.";

export const plane = {
  title: "One workflow. Your tools.",
  body: "Interlock defines the flow from ticket to pull request, coordinating workspace setup and cleanup around the tools you already use.",
  more: "Supported tools",
};

export const scopes = [
  {
    title: "Project configuration",
    body: "The tracker, repository and instructions for the work. Shared with the project.",
  },
  {
    title: "Local preferences",
    body: "Your session host, coding agent and model. Saved on your machine.",
  },
];

export const layers: Layer[] = [
  {
    id: "tracker",
    name: "Tracker",
    today: [chip("Jira", jira, "#0052CC")],
    soon: [chip("Linear", linear, "#5E6AD2"), chip("GitHub Issues", github, "#181717")],
  },
  {
    id: "git-remote",
    name: "Git remote",
    today: [chip("GitHub", github, "#181717")],
    soon: [],
  },
  {
    id: "machine",
    name: "Machine",
    gloss: "runs Interlock",
    today: [chip("Laptop", laptop), chip("Workstation", workstation)],
    soon: [chip("VPS", vps), chip("CI runner", ciRunner)],
  },
  {
    id: "environment",
    name: "Environment",
    gloss: "isolates the session",
    today: [chip("Native", native)],
    soon: [chip("Docker Sandbox", docker, "#2496ED")],
  },
  {
    id: "workspace",
    name: "Workspace",
    today: [chip("Git worktree", git, "#F03C2E")],
    soon: [],
  },
  {
    id: "harness",
    name: "Harness",
    gloss: "writes the code",
    today: [chip("Claude Code", claude, "#D97757"), chip("Codex", codex, "#000000")],
    soon: [
      chip("Pi", pi),
      chip("OpenCode", opencode, "#000000"),
      chip("Cursor", cursor, "#000000"),
      chip("Antigravity", antigravity, "#3186FF"),
    ],
  },
  {
    id: "host",
    name: "Host",
    gloss: "shows the session",
    today: [chip("T3 Code", t3code, "#000000")],
    soon: [
      chip("Conductor", conductor),
      chip("ChatGPT/Codex desktop app", codex, "#000000"),
      chip("Claude desktop app", claude, "#D97757"),
      chip("tmux", tmux, "#1BB91F"),
      chip("Herdr", herdr),
    ],
  },
  {
    id: "model",
    name: "Model",
    text: "Configured in local preferences",
    today: [],
    soon: [],
  },
];

export const footer = {
  license: "MIT License",
  credits: "Logos: Simple Icons (CC0); Git logo by Jason Long (CC BY 3.0); other marks from their owners.",
};

export const stageCommands = [
  { label: "Claim and prepare", from: 0, to: 5.5, text: 'interlock pickup TEST-492 --t3-catalog "$T3_CATALOG"' },
  { label: "Submit", from: 10, to: 16, text: 'interlock lane submit "$LANE" --artifact "$PR_URL" --head "$HEAD" --gate test --evidence-url "$EVIDENCE_URL"' },
  { label: "Complete after merge", from: 16.5, to: 19.5, text: 'interlock lane complete "$LANE"' },
];
