const tag = process.argv[2];
if (tag === "nightly") {
  const sha = process.argv[3];
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("nightly requires a full main commit SHA");
  process.stdout.write(`0.0.0-nightly.g${sha}\n`);
  process.exit(0);
}

const match =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/.exec(tag ?? "");

if (!match) {
  throw new Error(
    "release tag must be a strict SemVer prerelease such as v0.1.0-rc.1 (no build metadata)",
  );
}

for (const identifier of (match[4] ?? "").split(".")) {
  if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
    throw new Error(`numeric prerelease identifier has a leading zero: ${identifier}`);
  }
}

process.stdout.write(`${tag?.slice(1)}\n`);
