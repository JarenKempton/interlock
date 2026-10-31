import migration0000 from "./0000_lean_tag.sql" with { type: "text" };
import migration0001 from "./0001_late_ben_parker.sql" with { type: "text" };
import migration0002 from "./0002_silent_gertrude_yorkes.sql" with { type: "text" };
import migration0003 from "./0003_funny_phalanx.sql" with { type: "text" };
import migration0004 from "./0004_awesome_nitro.sql" with { type: "text" };

export interface LedgerMigration {
  tag: string;
  sql: string;
}

export const embeddedMigrations: readonly LedgerMigration[] = [
  { tag: "0000_lean_tag", sql: migration0000 },
  { tag: "0001_late_ben_parker", sql: migration0001 },
  { tag: "0002_silent_gertrude_yorkes", sql: migration0002 },
  { tag: "0003_funny_phalanx", sql: migration0003 },
  { tag: "0004_awesome_nitro", sql: migration0004 },
];
