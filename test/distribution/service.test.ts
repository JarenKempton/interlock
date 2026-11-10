import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installService,
  SERVICE_LABEL,
  serviceDefinition,
} from "../../src/distribution/service.ts";
import { rejection } from "../fixtures/rejection.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home() {
  const directory = mkdtempSync(join(tmpdir(), "interlock-service-"));
  homes.push(directory);
  return directory;
}

const command = ["/opt/interlock", "run", "--project", "JWB-470=/work/my repo"];

test("systemd unit starts at boot, restarts on failure and carries no secrets", () => {
  const root = home();
  const unit = serviceDefinition(command, {
    platform: "linux",
    home: root,
    uid: 1000,
    logDirectory: "/state",
    path: "/usr/bin:/home/u/.bun/bin",
  });
  expect(unit.path).toBe(join(root, ".config/systemd/user/interlock.service"));
  expect(unit.content).toContain('ExecStart=/opt/interlock run --project "JWB-470=/work/my repo"');
  expect(unit.content).toContain("Restart=on-failure");
  expect(unit.content).toContain("WantedBy=default.target");
  expect(unit.activate).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "interlock.service"],
    ["systemctl", "--user", "restart", "interlock.service"],
    ["loginctl", "enable-linger"],
  ]);
  expect(unit.content).not.toMatch(/token|password|JIRA_/i);
  expect(unit.content).toContain("Environment=PATH=/usr/bin:/home/u/.bun/bin");
});

test("launchd agent runs at load and is kept alive after a failed exit", () => {
  const root = home();
  const agent = serviceDefinition(command, {
    platform: "darwin",
    home: root,
    uid: 501,
    logDirectory: "/state",
    path: "/usr/bin:/home/u/.bun/bin",
  });
  expect(agent.path).toBe(join(root, `Library/LaunchAgents/${SERVICE_LABEL}.plist`));
  expect(agent.content).toContain("<key>RunAtLoad</key><true/>");
  expect(agent.content).toContain(
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
  );
  expect(agent.content).toContain("<string>JWB-470=/work/my repo</string>");
  expect(agent.content).toContain(
    "<dict><key>PATH</key><string>/usr/bin:/home/u/.bun/bin</string></dict>",
  );
  expect(agent.activate.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", agent.path]);
});

test("other platforms are refused", () => {
  expect(() =>
    serviceDefinition(command, {
      platform: "win32",
      home: "/h",
      uid: 0,
      logDirectory: "/s",
      path: "",
    }),
  ).toThrow("supports Linux (systemd) and macOS (launchd)");
});

test("install writes the definition, then activates it in order and stops on failure", async () => {
  const root = home();
  const unit = serviceDefinition(command, {
    platform: "linux",
    home: root,
    uid: 1000,
    logDirectory: "/state",
    path: "/usr/bin:/home/u/.bun/bin",
  });
  const ran: string[] = [];
  const results = await installService(unit, {
    run: async (argv) => {
      ran.push(argv.join(" "));
      return { exitCode: 0, stderr: "" };
    },
  });
  expect(readFileSync(unit.path, "utf8")).toBe(unit.content);
  expect(ran).toEqual(unit.activate.map((argv) => argv.join(" ")));
  expect(results.every((result) => result.exitCode === 0)).toBe(true);

  const refused = await rejection(
    installService(unit, { run: async () => ({ exitCode: 1, stderr: "no user bus" }) }),
  );
  expect(refused.message).toBe("systemctl --user daemon-reload failed (1): no user bus");
});

test("launchd tolerates bootout of an agent that is not loaded yet", async () => {
  const root = home();
  const agent = serviceDefinition(command, {
    platform: "darwin",
    home: root,
    uid: 501,
    logDirectory: "/state",
    path: "/usr/bin:/home/u/.bun/bin",
  });
  const results = await installService(agent, {
    run: async (argv) => ({ exitCode: argv[1] === "bootout" ? 3 : 0, stderr: "" }),
  });
  expect(results.map((result) => result.exitCode)).toEqual([3, 0]);
});

test("systemd arguments keep percent and dollar signs literal", () => {
  const unit = serviceDefinition(["/opt/interlock", "run", "--state", "/s/100%", "$HOME"], {
    platform: "linux",
    home: home(),
    uid: 1000,
    logDirectory: "/state",
    path: "/usr/bin",
  });
  expect(unit.content).toContain('ExecStart=/opt/interlock run --state /s/100%% "$$HOME"');
});
