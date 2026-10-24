export interface Terminal {
  interactive(): boolean;
  say(text: string): void;
  ask(label: string, options: { hidden: boolean; default?: string | undefined }): Promise<string>;
  open(url: string): void;
}

const ESCAPE = String.fromCharCode(27);

export const processTerminal: Terminal = {
  interactive: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  say(text) {
    process.stderr.write(`${text}\n`);
  },
  async ask(label, options) {
    const prompt = `${label}${options.default ? ` [${options.default}]` : ""}: `;
    const answer = await readLine(prompt, options.hidden);
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

export function lineInput(echo: (text: string) => void = () => {}) {
  let value = "";
  let skipping: "" | "escape" | "parameters" = "";
  return {
    feed(chunk: string): { state: "done" | "cancelled"; rest: string } | undefined {
      for (let index = 0; index < chunk.length; index++) {
        const character = chunk.charAt(index);
        if (skipping === "escape") skipping = character === "[" ? "parameters" : "";
        else if (skipping === "parameters")
          skipping = character >= "@" && character <= "~" ? "" : skipping;
        else if (character === ESCAPE) skipping = "escape";
        else if (character === "\r" || character === "\n") {
          const rest = chunk.slice(index + 1);
          return { state: "done", rest: character === "\r" ? rest.replace(/^\n/, "") : rest };
        } else if (character === "\u0003") return { state: "cancelled", rest: "" };
        else if (character === "\u007f" || character === "\b") {
          if (value) echo("\b \b");
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
          echo(character);
        }
      }
      return undefined;
    },
    value: () => value,
  };
}

let typedAhead = "";

async function readLine(prompt: string, hidden: boolean): Promise<string> {
  const input = lineInput(hidden ? undefined : (text) => process.stderr.write(text));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stderr.write(prompt);
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: string) => {
        const result = input.feed(chunk);
        if (!result) return;
        process.stdin.off("data", onData);
        typedAhead = result.rest;
        process.stderr.write("\n");
        if (result.state === "cancelled") reject(new Error("Sign-in cancelled"));
        else resolve(input.value());
      };
      process.stdin.on("data", onData);
      const pending = typedAhead;
      typedAhead = "";
      if (pending) onData(pending);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
