import type { Database, Statement } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const terminalMethods = new Set(["run", "get", "all", "values"]);

function finalizedStatement(statement: Statement): Statement {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!terminalMethods.has(String(property)))
        return (...args: unknown[]) => Reflect.apply(value, target, args);
      return (...args: unknown[]) => {
        try {
          return Reflect.apply(value, target, args);
        } finally {
          target.finalize();
        }
      };
    },
  });
}

export function ledgerDb(database: Database) {
  const client = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => finalizedStatement(target.prepare(sql));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(value, target, args)
        : value;
    },
  });
  return drizzle(client);
}
