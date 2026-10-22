import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "interlock-install-"));
  roots.push(root);
  const downloads = join(root, "downloads");
  const bin = join(root, "mock-bin");
  const install = join(root, "install");
  Bun.spawnSync(["mkdir", "-p", downloads, bin, install]);
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh\nset -eu\nurl=''\nout=''\nwhile [ "$#" -gt 0 ]; do\n case "$1" in\n  --output) out=$2; shift 2 ;;\n  --*) shift ;;\n  *) url=$1; shift ;;\n esac\ndone\nprintf '%s\\n' "$url" >> "$CURL_LOG"\ncp "$DOWNLOADS/\${url##*/}" "$out"\n`,
  );
  chmodSync(curl, 0o755);
  return { root, downloads, bin, install };
}

function runInstaller(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["sh", resolve("scripts/install.sh")], {
    env: {
      ...process.env,
      PATH: `${f.bin}:/usr/bin:/bin:/sbin`,
      HOME: f.root,
      DOWNLOADS: f.downloads,
      CURL_LOG: join(f.root, "curl.log"),
      INTERLOCK_INSTALL_DIR: f.install,
      INTERLOCK_BASE_URL: "https://fixtures.invalid/release",
      INTERLOCK_OS: "Linux",
      INTERLOCK_ARCH: "x86_64",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("POSIX installer", () => {
  test("requires an explicit prerelease version without a fixture base URL", () => {
    const f = fixture();
    const result = runInstaller(f, { INTERLOCK_BASE_URL: "", INTERLOCK_VERSION: "" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("INTERLOCK_VERSION is required");
    expect(existsSync(join(f.root, "curl.log"))).toBeFalse();
  });

  test("selects the platform asset, verifies it, and installs atomically", () => {
    const f = fixture();
    const asset = "interlock-linux-x64";
    writeFileSync(join(f.downloads, asset), "new binary");
    const hash = new Bun.CryptoHasher("sha256").update("new binary").digest("hex");
    writeFileSync(join(f.downloads, "checksums.txt"), `${hash}  ${asset}\n`);

    const result = runInstaller(f);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(f.install, "interlock"), "utf8")).toBe("new binary");
    expect(readFileSync(join(f.root, "curl.log"), "utf8")).toContain(`/release/${asset}`);
  });

  test("preserves the installed binary when checksum verification fails", () => {
    const f = fixture();
    const asset = "interlock-linux-arm64";
    writeFileSync(join(f.install, "interlock"), "previous binary");
    writeFileSync(join(f.downloads, asset), "corrupt download");
    writeFileSync(join(f.downloads, "checksums.txt"), `${"0".repeat(64)}  ${asset}\n`);

    const result = runInstaller(f, { INTERLOCK_ARCH: "aarch64" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(f.install, "interlock"), "utf8")).toBe("previous binary");
    expect(result.stderr.toString()).toContain("checksum verification failed");
  });

  test("fails before downloading an unsupported platform", () => {
    const f = fixture();
    const result = runInstaller(f, { INTERLOCK_OS: "FreeBSD" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unsupported operating system");
  });
});

if (process.platform === "win32") {
  test("PowerShell installer parses without syntax errors", () => {
    const result = Bun.spawnSync([
      "pwsh",
      "-NoProfile",
      "-Command",
      "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/install.ps1'), [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }",
    ]);
    expect(result.exitCode).toBe(0);
  });
}
