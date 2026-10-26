import migration0000 from "./0000_lean_tag.sql" with { type: "text" };

export interface LedgerMigration {
  tag: string;
  sql: string;
}

export const embeddedMigrations: readonly LedgerMigration[] = [
  { tag: "0000_lean_tag", sql: migration0000 },
];
