import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { McpServer } from "./server.ts";

export interface McpTransport {
  serve(server: McpServer): Promise<void>;
  close(): Promise<void>;
}

export class StdioTransport implements McpTransport {
  constructor(
    private readonly input: AsyncIterable<Uint8Array> = process.stdin,
    private readonly write: (text: string) => void = (text) => {
      process.stdout.write(text);
    },
  ) {}

  async serve(server: McpServer): Promise<void> {
    const session = server.stdioSession();
    const decoder = new TextDecoder();
    let buffer = "";
    const drain = async (flush = false) => {
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const response = await server.handleLine(line, session);
        if (response) this.write(`${response}\n`);
      }
      if (flush && buffer.trim()) {
        const response = await server.handleLine(buffer.trim(), session);
        if (response) this.write(`${response}\n`);
        buffer = "";
      }
    };
    for await (const chunk of this.input) {
      buffer += decoder.decode(chunk, { stream: true });
      await drain();
    }
    buffer += decoder.decode();
    await drain(true);
  }

  async close(): Promise<void> {}
}

export class SocketTransport implements McpTransport {
  private server: Server | undefined;
  private listening: Promise<void> | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(readonly path: string) {}

  async serve(server: McpServer): Promise<void> {
    const listener = createServer((socket) => {
      this.sockets.add(socket);
      const session = server.newSession();
      let buffer = "";
      let queue = Promise.resolve();
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines: string[] = [];
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) lines.push(line);
        }
        queue = queue.then(async () => {
          for (const line of lines) {
            const response = await server.handleLine(line, session);
            if (response && !socket.destroyed) socket.write(`${response}\n`);
          }
        });
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => this.sockets.delete(socket));
    });
    const closed = new Promise<void>((resolvePromise) => {
      listener.once("close", () => resolvePromise());
    });
    this.server = listener;
    this.listening = new Promise<void>((resolvePromise, reject) => {
      listener.once("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" ? new Error("MCP socket path already exists") : error),
      );
      listener.listen(this.path, () => resolvePromise());
    });
    await this.listening;
    await closed;
  }

  ready(): Promise<void> {
    return this.listening ?? Promise.reject(new Error("MCP socket transport is not serving"));
  }

  async close(): Promise<void> {
    const server = this.server;
    const listening = this.listening;
    this.server = undefined;
    this.listening = undefined;
    const started = await listening?.then(
      () => true,
      () => false,
    );
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server || !started) return;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(this.path, { force: true });
  }
}
