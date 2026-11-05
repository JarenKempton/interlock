import assert from "node:assert/strict";

const [indexArgument, countArgument, mode] = process.argv.slice(2);
const index = Number(indexArgument);
const count = Number(countArgument);
assert(Number.isInteger(count) && count > 0, "Shard count must be a positive integer");
assert(Number.isInteger(index) && index >= 1 && index <= count, "Shard index is out of range");
assert(mode === undefined || mode === "--list", "Expected --list or no extra argument");

const files = [...new Bun.Glob("test/**/*.test.{ts,js}").scanSync()].sort();
assert(files.length >= count, "Every shard must contain at least one test file");
const shards = Array.from({ length: count }, (_, shard) =>
  files.filter((_, position) => position % count === shard),
);
assert(
  shards.every((shard) => shard.length > 0),
  "Empty test shard",
);
assert.deepEqual(shards.flat().sort(), files);
const selected = shards[index - 1];
assert(selected);
console.log(JSON.stringify({ shard: index, count, totalFiles: files.length, files: selected }));
if (mode !== "--list") {
  const child = Bun.spawn([process.execPath, "test", ...selected.map((path) => `./${path}`)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
