import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SERVICE_LABEL = "build.interlock.supervisor";

export interface ServiceDefinition {
  manager: "systemd" | "launchd";
  path: string;
  content: string;
  activate: string[][];
}

export interface ServicePlatform {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  logDirectory: string;
}

function systemdWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function serviceDefinition(
  command: readonly string[],
  platform: ServicePlatform,
): ServiceDefinition {
  if (platform.platform === "linux") {
    const path = join(platform.home, ".config", "systemd", "user", "interlock.service");
    return {
      manager: "systemd",
      path,
      content: [
        "[Unit]",
        "Description=Interlock supervisor",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${command.map(systemdWord).join(" ")}`,
        "Restart=on-failure",
        "RestartSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
      activate: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "interlock.service"],
        ["loginctl", "enable-linger"],
      ],
    };
  }
  if (platform.platform === "darwin") {
    const path = join(platform.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const log = join(platform.logDirectory, "supervisor.log");
    return {
      manager: "launchd",
      path,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...command.map((word) => `    <string>${xml(word)}</string>`),
        "  </array>",
        "  <key>RunAtLoad</key><true/>",
        "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "  <key>ThrottleInterval</key><integer>30</integer>",
        `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
      activate: [
        ["launchctl", "bootout", `gui/${platform.uid}/${SERVICE_LABEL}`],
        ["launchctl", "bootstrap", `gui/${platform.uid}`, path],
      ],
    };
  }
  throw new Error(
    `interlock service install supports Linux (systemd) and macOS (launchd), not ${platform.platform}`,
  );
}

export interface ServiceRunner {
  run(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }>;
}

export const bunServiceRunner: ServiceRunner = {
  async run(argv) {
    const child = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, stderr };
  },
};

export async function installService(
  definition: ServiceDefinition,
  runner: ServiceRunner,
): Promise<{ command: string; exitCode: number }[]> {
  mkdirSync(dirname(definition.path), { recursive: true });
  writeFileSync(definition.path, definition.content, { mode: 0o644 });
  const results: { command: string; exitCode: number }[] = [];
  for (const [index, argv] of definition.activate.entries()) {
    const { exitCode, stderr } = await runner.run(argv);
    results.push({ command: argv.join(" "), exitCode });
    const bootout = definition.manager === "launchd" && index === 0;
    if (exitCode !== 0 && !bootout)
      throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
  }
  return results;
}
