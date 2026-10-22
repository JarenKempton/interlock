import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, notifyAboutUpdate } from "../src/distribution/update.ts";

const release = (tag: string, prerelease = false) => ({
  tag_name: tag,
  prerelease,
  draft: false,
  html_url: `https://github.com/JarenKempton/interlock/releases/tag/${tag}`,
});

describe("update notifications", () => {
  test("notifies interactive stable installations about newer stable releases", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "interlock-update-")), "cache.json");
    const result = await checkForUpdate({
      currentVersion: "1.2.3",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://releases.example.test/releases" },
      cachePath,
      now: () => new Date("2026-08-14T00:00:00Z"),
      fetch: async () => Response.json([release("v1.3.0"), release("v2.0.0-beta.1", true)]),
    });
    expect(result?.latestVersion).toBe("1.3.0");
    expect(JSON.parse(await readFile(cachePath, "utf8")).checkedAt).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  test("checks at most once per 24 hours", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "interlock-update-")), "cache.json");
    let requests = 0;
    const fetch = async () => {
      requests += 1;
      return Response.json([release("v1.3.0")]);
    };
    const base = {
      currentVersion: "1.2.3",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://releases.example.test/releases" },
      cachePath,
      fetch,
    };
    await checkForUpdate({ ...base, now: () => new Date("2026-08-14T00:00:00Z") });
    expect(
      await checkForUpdate({ ...base, now: () => new Date("2026-08-14T23:59:59Z") }),
    ).toBeUndefined();
    expect(requests).toBe(1);
  });

  test("never checks for noninteractive, opted-out, CI, or development runs", async () => {
    let requests = 0;
    const fetch = async () => {
      requests += 1;
      return Response.json([]);
    };
    for (const options of [
      { currentVersion: "1.0.0", interactive: false },
      { currentVersion: "1.0.0", interactive: true, json: true },
      { currentVersion: "1.0.0", interactive: true, environment: { CI: "true" } },
      {
        currentVersion: "1.0.0",
        interactive: true,
        environment: { INTERLOCK_NO_UPDATE_CHECK: "1" },
      },
      { currentVersion: "0.1.0-dev", interactive: true },
    ]) {
      await checkForUpdate({ ...options, fetch });
    }
    expect(requests).toBe(0);
  });

  test("prerelease installations can see newer prereleases without downgrading", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "interlock-update-")), "cache.json");
    const result = await checkForUpdate({
      currentVersion: "1.2.0-beta.1",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://releases.example.test/releases" },
      cachePath,
      fetch: async () => Response.json([release("v1.3.0-beta.1", true)]),
    });
    expect(result?.latestVersion).toBe("1.3.0-beta.1");
  });

  test("uses SemVer precedence for prereleases and does not trust API ordering", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "interlock-update-")), "cache.json");
    const result = await checkForUpdate({
      currentVersion: "1.2.0-beta.2",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://releases.example.test/releases" },
      cachePath,
      fetch: async () =>
        Response.json([
          release("v1.2.0-beta.3", true),
          release("v1.2.0-beta.11", true),
          release("v1.2.0-beta.alpha", true),
          release("v1.2.0-beta.4", true),
        ]),
    });
    expect(result?.latestVersion).toBe("1.2.0-beta.alpha");
  });

  test("records failed attempts so failure stays silent and is not retried for 24 hours", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interlock-update-"));
    const cachePath = join(directory, "cache.json");
    let requests = 0;
    const errors: string[] = [];
    const options = {
      currentVersion: "1.2.3",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://releases.example.test/releases" },
      cachePath,
      now: () => new Date("2026-08-14T00:00:00Z"),
      fetch: async () => {
        requests += 1;
        throw new Error("offline");
      },
      writeError: (message: string) => errors.push(message),
    };
    await notifyAboutUpdate(options);
    await notifyAboutUpdate(options);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("injects a short timeout signal and writes an available update only to stderr", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "interlock-update-")), "cache.json");
    const signal = new AbortController().signal;
    const timeouts: number[] = [];
    const errors: string[] = [];
    await notifyAboutUpdate({
      currentVersion: "1.2.3",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://releases.example.test/releases" },
      cachePath,
      timeoutSignal: (milliseconds) => {
        timeouts.push(milliseconds);
        return signal;
      },
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(signal);
        return Response.json([release("v1.2.4")]);
      },
      writeError: (message) => errors.push(message),
    });
    expect(timeouts).toEqual([2_000]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Interlock 1.2.4 is available");
  });

  test("honors the documented release metadata endpoint override", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "interlock-update-")), "cache.json");
    const requested: string[] = [];
    await checkForUpdate({
      currentVersion: "1.2.3",
      interactive: true,
      environment: { INTERLOCK_UPDATE_URL: "https://updates.example.test/releases" },
      cachePath,
      fetch: async (input) => {
        requested.push(String(input));
        return Response.json([]);
      },
    });
    expect(requested).toEqual(["https://updates.example.test/releases"]);
  });
});

test("an unconfigured source build has no implicit release owner, network access or cache writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "interlock-no-release-"));
  let requests = 0;
  const result = await checkForUpdate({
    currentVersion: "1.0.0",
    interactive: true,
    environment: {},
    cachePath: join(directory, "cache.json"),
    fetch: async () => {
      requests++;
      return Response.json([]);
    },
  });
  expect(result).toBeUndefined();
  expect(requests).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});

test("explicit release ownership is honored and malformed release records fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "interlock-release-owner-"));
  const endpoint = "https://releases.example.test/repos/fork/project/releases";
  let observed: unknown;
  const result = await checkForUpdate({
    currentVersion: "1.0.0",
    interactive: true,
    environment: { INTERLOCK_UPDATE_URL: endpoint },
    cachePath: join(directory, "cache.json"),
    fetch: async (url) => {
      observed = url;
      return Response.json([release("v1.1.0")]);
    },
  });
  expect(observed).toBe(endpoint);
  expect(result?.latestVersion).toBe("1.1.0");
  const messages: string[] = [];
  await notifyAboutUpdate({
    currentVersion: "1.0.0",
    interactive: true,
    intervalMs: 0,
    environment: { INTERLOCK_UPDATE_URL: endpoint },
    cachePath: join(directory, "cache.json"),
    fetch: async () => Response.json([{ tag_name: { private: "DO_NOT_ECHO" } }]),
    writeError: (text) => messages.push(text),
  });
  expect(messages).toEqual([]);
});
