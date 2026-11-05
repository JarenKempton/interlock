import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  for (const directory of [downloads, bin, install]) mkdirSync(directory);
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh
set -eu
url=''
out=''
status_format=''
while [ "$#" -gt 0 ]; do
 case "$1" in
  --output) out=$2; shift 2 ;;
  --write-out) status_format=$2; shift 2 ;;
  --*) shift ;;
  *) url=$1; shift ;;
 esac
done
printf '%s\\n' "$url" >> "$CURL_LOG"
[ "\${CURL_FAILURE:-}" != 1 ] || exit 7
name=\${url##*/}
case "$name" in releases\\?*) name=releases ;; esac
cp "$DOWNLOADS/$name" "$out"
if [ -n "$status_format" ]; then
 if [ -f "$DOWNLOADS/$name.status" ]; then
  cat "$DOWNLOADS/$name.status"
 else
  printf 200
 fi
fi
`,
  );
  chmodSync(curl, 0o755);
  const powershell = join(bin, "fixture.ps1");
  writeFileSync(
    powershell,
    `function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    Add-Content -LiteralPath $env:CURL_LOG -Value $Uri
    if ($env:CURL_FAILURE -eq '1') { throw 'Connection failed' }
    $name = ($Uri -split '/')[-1]
    if ($name.StartsWith('releases?')) { $name = 'releases' }
    $source = Join-Path $env:DOWNLOADS $name
    $statusFile = "$source.status"
    if (Test-Path -LiteralPath $statusFile) {
        $status = [int](Get-Content -LiteralPath $statusFile -Raw)
        if ($status -ne 200) {
            $response = [System.Net.Http.HttpResponseMessage]::new($status)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('API failure', $response)
        }
    }
    if ($OutFile) { Copy-Item -LiteralPath $source -Destination $OutFile }
    else { [pscustomobject]@{ Content = (Get-Content -LiteralPath $source -Raw); StatusCode = 200 } }
}
& $env:INSTALLER_SCRIPT
`,
  );
  return { root, downloads, bin, install, powershell };
}

const shells = [
  {
    name: "POSIX",
    executable: "interlock",
    platform: "linux",
    enabled: process.platform !== "win32",
  },
  {
    name: "PowerShell",
    executable: "interlock.exe",
    platform: "windows",
    enabled: Boolean(Bun.which("pwsh")),
  },
] as const;

function runInstaller(
  f: ReturnType<typeof fixture>,
  shell: (typeof shells)[number],
  extra: Record<string, string> = {},
) {
  const powershell = shell.name === "PowerShell";
  return Bun.spawnSync(
    powershell
      ? [Bun.which("pwsh") ?? "pwsh", "-NoProfile", "-File", f.powershell]
      : ["sh", resolve("scripts/install.sh")],
    {
      env: {
        ...process.env,
        ...(powershell ? {} : { PATH: `${f.bin}:/usr/bin:/bin:/sbin` }),
        HOME: f.root,
        DOWNLOADS: f.downloads,
        CURL_LOG: join(f.root, "curl.log"),
        CURL_FAILURE: "",
        INSTALLER_SCRIPT: resolve("scripts/install.ps1"),
        INTERLOCK_INSTALL_DIR: f.install,
        INTERLOCK_BASE_URL: "",
        INTERLOCK_VERSION: "",
        INTERLOCK_REPOSITORY: "JarenKempton/interlock",
        INTERLOCK_OS: "Linux",
        INTERLOCK_ARCH: "x86_64",
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function release(tag: string, prerelease = false) {
  return { tag_name: tag, draft: false, prerelease };
}

for (const shell of shells) {
  const suite = shell.enabled ? describe : describe.skip;
  suite(`${shell.name} installer`, () => {
    const installerTest = (name: string, body: () => void) =>
      test(name, body, shell.name === "PowerShell" ? 30_000 : 5_000);
    function binary(f: ReturnType<typeof fixture>, architecture = "x64", checksumValid = true) {
      const asset = `interlock-${shell.platform}-${architecture}${shell.name === "PowerShell" ? ".exe" : ""}`;
      writeFileSync(join(f.downloads, asset), "new binary");
      const hash = checksumValid
        ? new Bun.CryptoHasher("sha256").update("new binary").digest("hex")
        : "0".repeat(64);
      writeFileSync(join(f.downloads, "checksums.txt"), `${hash}  ${asset}\n`);
      return asset;
    }

    installerTest("unset version selects the newest stable from the releases API", () => {
      const f = fixture();
      binary(f);
      writeFileSync(join(f.downloads, "latest"), JSON.stringify(release("v1.2.3")));
      writeFileSync(
        join(f.downloads, "releases"),
        JSON.stringify([release("v2.0.0-alpha.1", true), release("v1.2.3")]),
      );
      const result = runInstaller(f, shell);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(f.install, shell.executable), "utf8")).toBe("new binary");
      const log = readFileSync(join(f.root, "curl.log"), "utf8");
      expect(log).toContain("https://api.github.com/repos/JarenKempton/interlock/releases/latest");
      expect(log).toContain("/releases/download/v1.2.3/");
      expect(log).not.toContain("?per_page");
      expect(result.stderr.toString()).not.toContain("(pre-release)");
    });

    installerTest(
      "unset prerelease-only version announces and installs the newest published prerelease",
      () => {
        const f = fixture();
        binary(f);
        writeFileSync(join(f.downloads, "latest"), '{"message":"Not Found"}');
        writeFileSync(join(f.downloads, "latest.status"), "404");
        writeFileSync(
          join(f.downloads, "releases"),
          JSON.stringify([
            { ...release("v9.0.0-alpha.1", true), draft: true },
            {
              ...release("v0.1.0-alpha.6", true),
              author: { tag_name: "v99", draft: false, prerelease: true },
              body: 'Quotes "tag_name": "v88", braces } [, backslash \\ and newline\n',
            },
            release("v0.1.0-alpha.5", true),
          ]),
        );
        const result = runInstaller(f, shell);
        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(f.install, shell.executable), "utf8")).toBe("new binary");
        expect(readFileSync(join(f.root, "curl.log"), "utf8")).toContain(
          "/releases/download/v0.1.0-alpha.6/",
        );
        expect(
          result.stderr
            .toString()
            .split(/\r?\n/)
            .filter((line) => line.includes("(pre-release)")),
        ).toEqual(["Installing Interlock v0.1.0-alpha.6 (pre-release)"]);
      },
    );

    installerTest("prerelease lookup requests one realistically sized release", () => {
      const f = fixture();
      binary(f);
      writeFileSync(join(f.downloads, "latest"), '{"message":"Not Found"}');
      writeFileSync(join(f.downloads, "latest.status"), "404");
      const payload = JSON.stringify([
        {
          ...release("v0.1.0-alpha.6", true),
          body: 'Release notes with escaped "quotes" and newline\n'.repeat(400),
          assets: Array.from({ length: 16 }, (_, id) => ({
            id,
            name: `asset-${id}`,
            uploader: { login: "release-bot", avatar_url: "https://example.test/avatar" },
            browser_download_url: `https://example.test/download/asset-${id}`,
          })),
        },
      ]);
      expect(payload.length).toBeGreaterThan(20_000);
      writeFileSync(join(f.downloads, "releases"), payload);
      const started = performance.now();
      const result = runInstaller(f, shell);
      if (shell.name === "POSIX") expect(performance.now() - started).toBeLessThan(5_000);
      expect(result.exitCode).toBe(0);
      const log = readFileSync(join(f.root, "curl.log"), "utf8");
      expect(log).toContain("/releases?per_page=1\n");
      expect(log).not.toContain("per_page=100");
      expect(readFileSync(join(f.install, shell.executable), "utf8")).toBe("new binary");
    });

    installerTest("automatic resolution preserves an API tag without a v prefix", () => {
      const f = fixture();
      binary(f);
      writeFileSync(join(f.downloads, "latest"), JSON.stringify(release("1.2.3")));
      const result = runInstaller(f, shell);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(f.root, "curl.log"), "utf8")).toContain("/releases/download/1.2.3/");
    });

    installerTest("explicit latest retains its existing rejection", () => {
      const f = fixture();
      const result = runInstaller(f, shell, { INTERLOCK_VERSION: "latest" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("INTERLOCK_VERSION is required");
      expect(existsSync(join(f.root, "curl.log"))).toBeFalse();
    });

    installerTest("explicit version and repository bypass API resolution", () => {
      const f = fixture();
      binary(f);
      const result = runInstaller(f, shell, {
        INTERLOCK_VERSION: "0.1.0-alpha.4",
        INTERLOCK_REPOSITORY: "example/interlock",
      });
      expect(result.exitCode).toBe(0);
      const log = readFileSync(join(f.root, "curl.log"), "utf8");
      expect(log).toContain(
        "https://github.com/example/interlock/releases/download/v0.1.0-alpha.4/",
      );
      expect(log).not.toContain("api.github.com");
      expect(result.stderr.toString()).not.toContain("(pre-release)");
    });

    installerTest("base URL override still bypasses version resolution", () => {
      const f = fixture();
      const asset = binary(f);
      const result = runInstaller(f, shell, {
        INTERLOCK_BASE_URL: "https://fixtures.invalid/release/",
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(f.root, "curl.log"), "utf8")).toContain(`/release/${asset}`);
      expect(readFileSync(join(f.root, "curl.log"), "utf8")).not.toContain("api.github.com");
    });

    for (const failure of [
      "403",
      "500",
      "connection",
      "malformed",
      "truncated",
      "empty",
      "fallback",
      "fallback-malformed",
      "fallback-nonarray",
      "latest-prerelease",
      "latest-draft",
    ]) {
      installerTest(
        `API ${failure} failure preserves the installed executable and never downloads assets`,
        () => {
          const f = fixture();
          writeFileSync(join(f.install, shell.executable), "previous binary");
          writeFileSync(
            join(f.downloads, "latest"),
            failure === "malformed"
              ? '{"tag_name":"v1", broken}'
              : failure === "truncated"
                ? '{"tag_name":"v1","draft":false,"prerelease":false'
                : failure === "empty"
                  ? "{}"
                  : JSON.stringify(release("v1")),
          );
          if (["403", "500"].includes(failure))
            writeFileSync(join(f.downloads, "latest.status"), failure);
          if (failure === "fallback") {
            writeFileSync(join(f.downloads, "latest.status"), "404");
            writeFileSync(join(f.downloads, "releases"), "{}");
            writeFileSync(join(f.downloads, "releases.status"), "503");
          }
          if (failure.startsWith("fallback-")) {
            writeFileSync(join(f.downloads, "latest.status"), "404");
            writeFileSync(
              join(f.downloads, "releases"),
              failure === "fallback-malformed" ? "[broken" : JSON.stringify(release("v1", true)),
            );
          }
          if (failure === "latest-prerelease" || failure === "latest-draft") {
            writeFileSync(
              join(f.downloads, "latest"),
              JSON.stringify({
                ...release("v1"),
                prerelease: failure === "latest-prerelease",
                draft: failure === "latest-draft",
              }),
            );
          }
          const result = runInstaller(f, shell, {
            CURL_FAILURE: failure === "connection" ? "1" : "",
          });
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr.toString()).toContain("GitHub releases API");
          expect(readFileSync(join(f.install, shell.executable), "utf8")).toBe("previous binary");
          expect(readFileSync(join(f.root, "curl.log"), "utf8")).not.toContain(
            "/releases/download/",
          );
        },
      );
    }

    installerTest("preserves the installed binary when checksum verification fails", () => {
      const f = fixture();
      binary(f, "arm64", false);
      writeFileSync(join(f.install, shell.executable), "previous binary");
      const result = runInstaller(f, shell, {
        INTERLOCK_ARCH: "aarch64",
        INTERLOCK_VERSION: "v1.2.3",
      });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(f.install, shell.executable), "utf8")).toBe("previous binary");
      expect(result.stderr.toString()).toContain("checksum verification failed");
    });

    installerTest("fails before downloading an unsupported architecture", () => {
      const f = fixture();
      const result = runInstaller(f, shell, { INTERLOCK_ARCH: "mips" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("unsupported architecture");
      expect(existsSync(join(f.root, "curl.log"))).toBeFalse();
    });
  });
}
