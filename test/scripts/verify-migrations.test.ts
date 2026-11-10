import { expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/verify-migrations.ts");

function withMigrationCopy(check: (root: string, migrations: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "interlock-migration-hashes-"));
  const migrations = join(root, "src/persistence/migrations");
  cpSync(resolve("src/persistence/migrations"), migrations, { recursive: true });
  try {
    check(root, migrations);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["bun", script, ...args], { cwd: root });
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

test("db:hash refuses to rehash an edited committed migration", () => {
  withMigrationCopy((root, migrations) => {
    const hashes = readFileSync(join(migrations, "hashes.json"), "utf8");
    appendFileSync(join(migrations, "0000_lean_tag.sql"), "\n-- edited\n");
    const result = run(root, "--write");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Committed migration was edited: 0000_lean_tag.sql");
    expect(readFileSync(join(migrations, "hashes.json"), "utf8")).toBe(hashes);
  });
});

test("db:hash adds only the new migration and db:check then passes", () => {
  withMigrationCopy((root, migrations) => {
    const before = JSON.parse(readFileSync(join(migrations, "hashes.json"), "utf8"));
    writeFileSync(join(migrations, "9999_new.sql"), "SELECT 1;\n");
    expect(run(root).output).toContain("Migration has no committed hash: 9999_new.sql");
    expect(run(root, "--write").exitCode).toBe(0);
    const after = JSON.parse(readFileSync(join(migrations, "hashes.json"), "utf8"));
    expect(Object.keys(after)).toEqual([...Object.keys(before), "9999_new.sql"]);
    for (const name of Object.keys(before)) expect(after[name]).toBe(before[name]);
    expect(run(root).exitCode).toBe(0);
  });
});
