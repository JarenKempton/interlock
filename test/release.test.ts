import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const sha = "1234567890abcdef1234567890abcdef12345678";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const workflow = z
  .object({
    jobs: z.record(
      z.string(),
      z.object({
        needs: z.union([z.string(), z.array(z.string())]).optional(),
        if: z.string().optional(),
        steps: z.array(
          z.object({
            name: z.string().optional(),
            run: z.string().optional(),
            uses: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    ),
  })
  .parse(Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8")));

function prepare(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "interlock-nightly-"));
  roots.push(root);
  writeFileSync(join(root, "git"), '#!/bin/sh\nprintf "%s\\n" "$MAIN_SHA"\n');
  writeFileSync(
    join(root, "curl"),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$RELEASE_JSON" > "$output"
printf '%s' "$HTTP_STATUS"
exit "$CURL_EXIT"
`,
  );
  for (const name of ["git", "curl"]) chmodSync(join(root, name), 0o755);
  const output = join(root, "output");
  writeFileSync(output, "");
  const script = workflow.jobs.prepare?.steps.find(
    (step) => step.name === "Resolve release source",
  )?.run;
  if (!script) throw new Error("Missing release planning script");
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      MAIN_SHA: sha,
      EVENT_NAME: "schedule",
      REF_NAME: "main",
      API_URL: "https://example.invalid",
      REPOSITORY: "fixture/interlock",
      GITHUB_OUTPUT: output,
      HTTP_STATUS: "404",
      RELEASE_JSON: "{}",
      CURL_EXIT: "0",
      ...extra,
    },
  });
  return { ...result, output: readFileSync(output, "utf8") };
}

(process.platform === "win32" ? describe.skip : describe)("nightly planning dry run", () => {
  test("first nightly pins a full source SHA and version", () => {
    const result = prepare();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      `build=true\nsha=${sha}\ntag=nightly\nversion=0.0.0-nightly.g${sha}\n`,
    );
  });

  test.each([sha, "a".repeat(40)])("compares published source %s with main", (previous) => {
    const result = prepare({
      HTTP_STATUS: "200",
      RELEASE_JSON: JSON.stringify({
        tag_name: "nightly",
        prerelease: true,
        draft: false,
        target_commitish: previous,
        body: `<!-- interlock-nightly-sha:${previous} -->`,
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(previous === sha ? "build=false\n" : "build=true\n");
  });

  test("retries an incomplete publication even when its target already names main", () => {
    const result = prepare({
      HTTP_STATUS: "200",
      RELEASE_JSON: JSON.stringify({
        tag_name: "nightly",
        prerelease: true,
        draft: false,
        target_commitish: sha,
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("build=true\n");
    expect(workflow.jobs.publish?.steps.at(-1)?.name).toBe("Record completed nightly publication");
  });

  test.each([
    { REF_NAME: "another-default-branch" },
    { HTTP_STATUS: "403" },
    { HTTP_STATUS: "500" },
    { CURL_EXIT: "7" },
    { HTTP_STATUS: "200", RELEASE_JSON: "not json" },
    { HTTP_STATUS: "200", RELEASE_JSON: "{}" },
  ])("lookup failures never enable publication: %j", (extra) => {
    const result = prepare(extra);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("build=true");
  });

  test("tagged prereleases use the same preparation without nightly lookup", () => {
    const result = prepare({ EVENT_NAME: "push", REF_NAME: "v1.2.3-rc.1", CURL_EXIT: "7" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`build=true\nsha=${sha}\ntag=v1.2.3-rc.1\nversion=1.2.3-rc.1\n`);
  });

  test("nightly version rejects missing or abbreviated source identity", () => {
    for (const source of ["", "123abcd", "main", "G".repeat(40)]) {
      expect(
        Bun.spawnSync(["bun", "scripts/release-version.ts", "nightly", source]).exitCode,
      ).not.toBe(0);
    }
  });

  test("publication completion stamps the source only after uploads finish", () => {
    const root = mkdtempSync(join(tmpdir(), "interlock-nightly-complete-"));
    roots.push(root);
    writeFileSync(
      join(root, "gh"),
      `#!/bin/sh
set -eu
case "$*" in
  *"--method PATCH"*) tee "$PATCH_INPUT" ;;
  *) printf '%s' "$RELEASE_JSON" ;;
esac
`,
    );
    chmodSync(join(root, "gh"), 0o755);
    const script = workflow.jobs.publish?.steps.at(-1)?.run;
    if (!script) throw new Error("Missing publication completion script");
    const patch = join(root, "patch.json");
    const result = Bun.spawnSync(["bash", "-c", script], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        SHA: sha,
        REPOSITORY: "fixture/interlock",
        PATCH_INPUT: patch,
        RELEASE_JSON: JSON.stringify({
          id: 42,
          body: `Release notes\n<!-- interlock-nightly-sha:${"a".repeat(40)} -->`,
        }),
      },
    });
    expect(result.exitCode).toBe(0);
    const update = z.object({ body: z.string() }).parse(JSON.parse(readFileSync(patch, "utf8")));
    expect(update.body).toContain("Release notes");
    expect(update.body).toContain(`<!-- interlock-nightly-sha:${sha} -->`);
    expect(update.body).not.toContain("a".repeat(40));
  });

  test("all release jobs share gates and check out the resolved commit", () => {
    expect(workflow.jobs.verify?.if).toBe("needs.prepare.outputs.build == 'true'");
    expect(workflow.jobs.build?.needs).toEqual(["prepare", "verify"]);
    expect(workflow.jobs.smoke?.needs).toEqual(["prepare", "build"]);
    expect(workflow.jobs.publish?.needs).toEqual(["prepare", "smoke"]);
    for (const job of ["verify", "build", "publish"]) {
      const checkout = workflow.jobs[job]?.steps.find(
        (step) => step.uses === "actions/checkout@v4",
      );
      expect(checkout?.with?.ref).toBe("${{ needs.prepare.outputs.sha }}");
    }
    const publish = workflow.jobs.publish?.steps.find(
      (step) => step.uses === "softprops/action-gh-release@v2",
    );
    expect(publish?.with?.tag_name).toBe("${{ needs.prepare.outputs.tag }}");
    expect(publish?.with?.target_commitish).toBe("${{ needs.prepare.outputs.sha }}");
    expect(publish?.with?.prerelease).toBe(true);
    expect(publish?.with?.make_latest).toBe(false);
  });
});

describe("prerelease workflow", () => {
  test.each(["v0.1.0-rc.1", "v2.0.0-beta", "v10.20.30-alpha.1"])(
    "accepts strict prerelease tag %s",
    (tag) => {
      const result = Bun.spawnSync(["bun", "scripts/release-version.ts", tag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(tag.slice(1));
    },
  );

  test.each(["0.1.0-rc.1", "v0.1.0", "v01.1.0-rc.1", "v1.0.0-rc.01", "v1.0.0+meta"])(
    "rejects invalid prerelease tag %s",
    (tag) => {
      expect(Bun.spawnSync(["bun", "scripts/release-version.ts", tag]).exitCode).not.toBe(0);
    },
  );

  test("publishes, checksums, and attests the man page and SBOM", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const checksumStep = workflow.split("- name: Generate checksums")[1]?.split("- name:")[0];
    expect(checksumStep).toContain("interlock.1");
    expect(checksumStep).toContain("interlock.spdx.json");
    const attestation = workflow
      .split("- name: Attest release artifacts")[1]
      ?.split("- name: Publish GitHub prerelease")[0];
    expect(attestation).toContain("dist/interlock.1");
    expect(attestation).toContain("dist/interlock.spdx.json");
    const publication = workflow.split("- name: Publish GitHub prerelease")[1];
    expect(publication).toContain("dist/interlock.1");
    expect(publication).toContain("dist/interlock.spdx.json");
  });
});
