import { Database } from "bun:sqlite";
import type { PersonalSettings, ResolvedConfiguration } from "../configuration/schema.ts";
import type { Claim, ClaimRef, Run, RunRef } from "../domain/model.ts";
import { configurationStore } from "./configuration.ts";

const schema = `
CREATE TABLE IF NOT EXISTS configuration_overrides (
  project_path TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_configurations (
  run_ref TEXT PRIMARY KEY REFERENCES runs(ref),
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  ref TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  context TEXT,
  workspace_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  execution_json TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  ref TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  human_owner TEXT NOT NULL,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  previous_state_json TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version TEXT,
  supersedes TEXT,
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS recovery_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  outcome TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  state TEXT NOT NULL,
  receipt_json TEXT,
  error_text TEXT,
  occurred_at TEXT NOT NULL
);`;

interface RunRow {
  ref: RunRef;
  ticket: Run["ticket"];
  harness: Run["harness"];
  model: string | null;
  effort: string | null;
  context: string | null;
  workspace_json: string;
  capabilities_json: string;
  status: Run["status"];
  created_at: string;
  updated_at: string;
  execution_json: string | null;
}

interface ClaimRow {
  ref: ClaimRef;
  ticket: Claim["ticket"];
  human_owner: Claim["humanOwner"];
  run_ref: RunRef;
  previous_state_json: string;
  claimed_at: string;
  lease_expires_at: string;
  status: Claim["status"];
  current_version: string | null;
  supersedes: ClaimRef | null;
  superseded_by: ClaimRef | null;
}

export class StateStore {
  readonly #database: Database;

  constructor(path: string) {
    if (!path) throw new Error("Database path is required");
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec(schema);
  }

  close(): void {
    this.#database.close();
  }

  updateConfigurationOverrides(
    projectPath: string,
    update: (settings: PersonalSettings) => PersonalSettings,
  ): PersonalSettings {
    const config = configurationStore(this.#database);
    return this.#database
      .transaction(() => config.savePersonal(projectPath, update(config.readPersonal(projectPath))))
      .immediate();
  }

  /** Initial snapshots are insert-only and retain the existing run foreign key. */
  saveExecutionConfiguration(run: RunRef, configuration: ResolvedConfiguration): void {
    configurationStore(this.#database).saveSnapshot(run, configuration);
  }

  getExecutionConfiguration(run: RunRef): ResolvedConfiguration | undefined {
    return configurationStore(this.#database).readSnapshot(run);
  }

  saveRun(run: Run): void {
    this.#database
      .query(`INSERT INTO runs(ref,ticket,harness,model,effort,context,workspace_json,capabilities_json,status,created_at,updated_at,execution_json)
        VALUES($ref,$ticket,$harness,$model,$effort,$context,$workspace,$capabilities,$status,$createdAt,$updatedAt,$execution)
        ON CONFLICT(ref) DO UPDATE SET model=excluded.model,effort=excluded.effort,context=excluded.context,
          workspace_json=excluded.workspace_json,
          capabilities_json=excluded.capabilities_json,status=excluded.status,updated_at=excluded.updated_at,
          execution_json=excluded.execution_json`)
      .run({
        ref: run.ref,
        ticket: run.ticket,
        harness: run.harness,
        model: run.model ?? null,
        effort: run.effort ?? null,
        context: run.context ?? null,
        workspace: JSON.stringify(run.workspace),
        capabilities: JSON.stringify(run.capabilities),
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        execution: run.execution ? JSON.stringify(run.execution) : null,
      });
  }

  run(ref: RunRef): Run {
    const row = this.#database.query<RunRow, [string]>("SELECT * FROM runs WHERE ref=?").get(ref);
    if (!row) throw new Error(`Run not found: ${ref}`);
    return {
      ref: row.ref,
      ticket: row.ticket,
      harness: row.harness,
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      ...(row.context ? { context: row.context } : {}),
      workspace: JSON.parse(row.workspace_json),
      capabilities: JSON.parse(row.capabilities_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.execution_json ? { execution: JSON.parse(row.execution_json) } : {}),
    };
  }

  saveClaim(claim: Claim): void {
    this.#database
      .query(`INSERT INTO claims(ref,ticket,human_owner,run_ref,previous_state_json,claimed_at,lease_expires_at,status,current_version,supersedes,superseded_by)
        VALUES($ref,$ticket,$owner,$run,$previous,$claimedAt,$expiresAt,$status,$version,$supersedes,$supersededBy)
        ON CONFLICT(ref) DO UPDATE SET lease_expires_at=excluded.lease_expires_at,status=excluded.status,
          current_version=excluded.current_version,supersedes=excluded.supersedes,superseded_by=excluded.superseded_by`)
      .run({
        ref: claim.ref,
        ticket: claim.ticket,
        owner: claim.humanOwner,
        run: claim.run,
        previous: JSON.stringify(claim.previousState),
        claimedAt: claim.claimedAt,
        expiresAt: claim.leaseExpiresAt,
        status: claim.status,
        version: claim.currentVersion ?? null,
        supersedes: claim.supersedes ?? null,
        supersededBy: claim.supersededBy ?? null,
      });
  }

  saveRecoveryRequired(run: Run, receipt: unknown, error: unknown, evidence: unknown): void {
    this.#transaction(() => {
      this.saveRun(run);
      this.recordStep(run.ref, "recovery_required", receipt, error);
      this.recordRecovery(run.ref, "verification_required", evidence);
    });
  }

  commitClaim(claim: Claim, receipt: unknown): void {
    this.#transaction(() => {
      this.saveClaim(claim);
      this.recordStep(claim.run, "claimed", receipt);
    });
  }

  commitRun(run: Run, state: string, receipt: unknown): void {
    this.#transaction(() => {
      this.saveRun(run);
      this.recordStep(run.ref, state, receipt);
    });
  }

  commitRelease(run: Run, claim: Claim, receipt: unknown): void {
    this.#transaction(() => {
      this.saveClaim(claim);
      this.commitRun(run, "released", receipt);
    });
  }

  claim(ref: ClaimRef): Claim {
    const row = this.#database
      .query<ClaimRow, [string]>("SELECT * FROM claims WHERE ref=?")
      .get(ref);
    if (!row) throw new Error(`Claim not found: ${ref}`);
    return claimFromRow(row);
  }

  claimForRun(run: RunRef): Claim {
    const row = this.#database
      .query<ClaimRow, [string]>(
        "SELECT * FROM claims WHERE run_ref=? ORDER BY claimed_at DESC LIMIT 1",
      )
      .get(run);
    if (!row) throw new Error(`Claim not found for run: ${run}`);
    return claimFromRow(row);
  }

  steps(run: RunRef): unknown[] {
    return this.#database
      .query(
        "SELECT state,receipt_json,error_text,occurred_at FROM transaction_steps WHERE run_ref=? ORDER BY id",
      )
      .all(run);
  }

  recordRecovery(run: RunRef, outcome: string, evidence: unknown): void {
    this.#database
      .query(
        "INSERT INTO recovery_evidence(run_ref,outcome,evidence_json,occurred_at) VALUES(?,?,?,?)",
      )
      .run(run, outcome, JSON.stringify(evidence), new Date().toISOString());
  }

  recoveryEvidence(run: RunRef): unknown[] {
    return this.#database
      .query(
        "SELECT outcome,evidence_json,occurred_at FROM recovery_evidence WHERE run_ref=? ORDER BY id",
      )
      .all(run);
  }

  listRuns(): Run[] {
    const rows = this.#database
      .query<{ ref: RunRef }, []>("SELECT ref FROM runs ORDER BY created_at DESC")
      .all();
    return rows.map(({ ref }) => this.run(ref));
  }

  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void {
    this.#database
      .query(`INSERT INTO transaction_steps(run_ref,state,receipt_json,error_text,occurred_at)
        VALUES(?,?,?,?,?)`)
      .run(
        run,
        state,
        receipt === undefined ? null : JSON.stringify(receipt),
        error === undefined ? null : errorMessage(error),
        new Date().toISOString(),
      );
  }

  #transaction(operation: () => void): void {
    this.#database.transaction(operation)();
  }
}

function claimFromRow(row: ClaimRow): Claim {
  return {
    ref: row.ref,
    ticket: row.ticket,
    humanOwner: row.human_owner,
    run: row.run_ref,
    previousState: JSON.parse(row.previous_state_json),
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    status: row.status,
    ...(row.current_version ? { currentVersion: row.current_version } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
