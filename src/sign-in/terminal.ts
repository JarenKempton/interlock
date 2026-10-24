import { createInterface } from "node:readline/promises";

export interface Terminal {
  interactive(): boolean;
  say(text: string): void;
  ask(label: string, options: { hidden: boolean; default?: string | undefined }): Promise<string>;
  open(url: string): void;
}

const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export const processTerminal: Terminal = {
  interactive: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  say(text) {
    process.stderr.write(`${text}\n`);
  },
  async ask(label, options) {
    const prompt = `${label}${options.default ? ` [${options.default}]` : ""}: `;
    const answer = options.hidden ? await readHidden(prompt) : await readVisible(prompt);
    return answer.trim() || options.default || "";
  },
  open(url) {
    const argv =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : ["xdg-open", url];
    try {
      Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    } catch {}
  },
};

async function readVisible(prompt: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await lines.question(prompt);
  } finally {
    lines.close();
  }
}

export function hiddenInput(): {
  feed(chunk: string): "done" | "cancelled" | undefined;
  value(): string;
} {
  let value = "";
  return {
    feed(chunk) {
      for (const character of chunk.replace(ESCAPE_SEQUENCE, "")) {
        if (character === "\r" || character === "\n") return "done";
        if (character === "\u0003") return "cancelled";
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
      return undefined;
    },
    value: () => value,
  };
}

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const input = hiddenInput();
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: string) => {
        const state = input.feed(chunk);
        if (!state) return;
        process.stdin.off("data", onData);
        process.stderr.write("\n");
        if (state === "cancelled") reject(new Error("Sign-in cancelled"));
        else resolve(input.value());
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
