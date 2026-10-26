import migration0000 from "./0000_lean_tag.sql" with { type: "text" };
import migration0001 from "./0001_spooky_owl.sql" with { type: "text" };

export interface LedgerMigration {
  tag: string;
  sql: string;
}

export const embeddedMigrations: readonly LedgerMigration[] = [
  { tag: "0000_lean_tag", sql: migration0000 },
  { tag: "0001_spooky_owl", sql: migration0001 },
];
