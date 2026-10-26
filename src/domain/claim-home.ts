import { win32 } from "node:path";

export interface ClaimHome {
  identity: string;
  url: string;
}

const invalid = "Claim home must be a Git remote URL or owner/repo";

export function normalizeClaimHome(value: string): ClaimHome {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || /[\s\p{Cc}]/u.test(trimmed)) throw new Error(invalid);
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (shorthand?.[1] && shorthand[2] && !trimmed.startsWith(".")) {
    const repo = stripGitSuffix(shorthand[2]);
    return {
      identity: remoteIdentity("github.com", `${shorthand[1]}/${repo}`),
      url: `https://github.com/${shorthand[1]}/${repo}.git`,
    };
  }
  if (win32.isAbsolute(trimmed) && !/^[A-Za-z]:[^\\/]/.test(trimmed))
    return { identity: stripGitSuffix(trimmed), url: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(trimmed);
    if (!scp?.[1] || !scp[2]) throw new Error(invalid);
    return { identity: remoteIdentity(scp[1], scp[2]), url: trimmed };
  }
  if (url.username && url.protocol !== "ssh:") throw new Error(`${invalid}, without credentials`);
  if (url.password || url.search || url.hash) throw new Error(`${invalid}, without credentials`);
  if (url.protocol === "file:") {
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    return { identity: stripGitSuffix(path), url: path };
  }
  const defaultPort = { "https:": "443", "ssh:": "22", "git:": "9418" }[url.protocol];
  if (!defaultPort) throw new Error("Claim home must use an https, ssh, git, or file remote");
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  return { identity: remoteIdentity(`${url.hostname}${port}`, url.pathname), url: trimmed };
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/, "");
}

function remoteIdentity(host: string, path: string): string {
  const repository = stripGitSuffix(path.replace(/^\/+/, ""));
  if (!host || !repository) throw new Error(invalid);
  const name = host.toLowerCase();
  return `${name}/${name === "github.com" ? repository.toLowerCase() : repository}`;
}
