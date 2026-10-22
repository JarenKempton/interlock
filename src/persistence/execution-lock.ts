import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";

export function lockExecution(path: string): () => void {
  const database = new Database(`${realpathSync(path)}.execution-lock`, { create: true });
  try {
    database.exec("PRAGMA busy_timeout=0");
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
    )
      throw new Error("Another pickup or release is using this ledger; retry after it exits", {
        cause: error,
      });
    throw error;
  }
  return () => database.close();
}
