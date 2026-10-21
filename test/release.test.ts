import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
