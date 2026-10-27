import { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type {
  PersonalSettings,
  ResolvedConfiguration,
  UserSettingKey,
  UserSettings,
} from "../configuration/schema.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../domain/identifiers.ts";
import type { Lane, LaneState } from "../domain/lane.ts";
import type { Claim, ClaimRef, LaneRef, Run, RunRef } from "../domain/model.ts";
import { configurationStore } from "./configuration.ts";
import { ledgerDb } from "./ledger-db.ts";
import { type LedgerMigration, migrateLedger } from "./migrate.ts";
import { claims } from "./schema/claims.ts";
import { lanes } from "./schema/lanes.ts";
import { recoveryEvidence } from "./schema/recovery-evidence.ts";
import { runs } from "./schema/runs.ts";
import { transactionSteps } from "./schema/transaction-steps.ts";

export interface StateStoreOptions {
  migrations?: readonly LedgerMigration[];
}

export class StateStore {
  readonly #database: Database;
  readonly #db: ReturnType<typeof ledgerDb>;
  readonly ledgerVersion: number;
  readonly migrationBackupPath: string | undefined;

  constructor(path: string, options: StateStoreOptions = {}) {
    if (!path) throw new Error("Database path is required");
    this.#database = new Database(path, { create: true, strict: true });
    try {
      this.#database.exec("PRAGMA journal_mode=WAL");
      const result = options.migrations
        ? migrateLedger(this.#database, path, options.migrations)
        : migrateLedger(this.#database, path);
      this.ledgerVersion = result.version;
      this.migrationBackupPath = result.backupPath;
      this.#database.exec("PRAGMA foreign_keys=ON");
    } catch (error) {
      try {
        this.#database.close();
      } catch {}
      throw error;
    }
    this.#db = ledgerDb(this.#database);
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

  userSettings(): UserSettings {
    return configurationStore(this.#database).readUser();
  }

  saveUserSetting(name: UserSettingKey, value: string | undefined): void {
    configurationStore(this.#database).saveUser(name, value);
  }

  claimHome(): string | undefined {
    return this.userSettings().claim_home;
  }

  saveClaimHomeIfAbsent(home: string): boolean {
    return this.#database
      .transaction(() => {
        if (this.claimHome() !== undefined) return false;
        this.saveUserSetting("claim_home", home);
        return true;
      })
      .immediate();
  }

  saveExecutionConfiguration(run: RunRef, configuration: ResolvedConfiguration): void {
    configurationStore(this.#database).saveSnapshot(run, configuration);
  }

  getExecutionConfiguration(run: RunRef): ResolvedConfiguration | undefined {
    return configurationStore(this.#database).readSnapshot(run);
  }

  saveRun(run: Run): void {
    const values = {
      ref: run.ref,
      ticket: run.ticket,
      harness: run.harness,
      model: run.model ?? null,
      workspace_json: JSON.stringify(run.workspace),
      capabilities_json: JSON.stringify(run.capabilities),
      status: run.status,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
    };
    this.#db
      .insert(runs)
      .values(values)
      .onConflictDoUpdate({
        target: runs.ref,
        set: {
          model: values.model,
          workspace_json: values.workspace_json,
          capabilities_json: values.capabilities_json,
          status: values.status,
          updated_at: values.updated_at,
        },
      })
      .run();
  }

  run(ref: RunRef): Run {
    const row = this.#db.select().from(runs).where(eq(runs.ref, ref)).get();
    if (!row) throw new Error(`Run not found: ${ref}`);
    return {
      ref: runRefSchema.parse(row.ref),
      ticket: ticketRefSchema.parse(row.ticket),
      harness: adapterRefSchema.parse(row.harness),
      ...(row.model ? { model: row.model } : {}),
      workspace: JSON.parse(row.workspace_json),
      capabilities: JSON.parse(row.capabilities_json),
      status: z
        .enum(["planning", "claimed", "compensated", "collision", "released", "recovery_required"])
        .parse(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveClaim(claim: Claim): void {
    const values = {
      ref: claim.ref,
      ticket: claim.ticket,
      human_owner: claim.humanOwner,
      run_ref: claim.run,
      previous_state_json: JSON.stringify(claim.previousState),
      claimed_at: claim.claimedAt,
      lease_expires_at: claim.leaseExpiresAt,
      status: claim.status,
      current_version: claim.currentVersion ?? null,
      claim_home: claim.claimHome ?? null,
      claim_home_url: claim.claimHomeUrl ?? null,
      record_version: claim.recordVersion ?? null,
      lock_ref: claim.lockRef ?? null,
      config_commit: claim.configCommit ?? null,
    };
    this.#db
      .insert(claims)
      .values(values)
      .onConflictDoUpdate({
        target: claims.ref,
        set: {
          lease_expires_at: values.lease_expires_at,
          status: values.status,
          current_version: values.current_version,
          claim_home: values.claim_home,
          claim_home_url: values.claim_home_url,
          record_version: values.record_version,
          lock_ref: values.lock_ref,
          config_commit: values.config_commit,
        },
      })
      .run();
  }

  saveRecoveryRequired(run: Run, receipt: unknown, error: unknown, evidence: unknown): void {
    this.#transaction(() => {
      this.saveRun(run);
      this.recordStep(run.ref, "recovery_required", receipt, error);
      this.#recordRecovery(run.ref, "verification_required", evidence);
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
    const row = this.#db.select().from(claims).where(eq(claims.ref, ref)).get();
    if (!row) throw new Error(`Claim not found: ${ref}`);
    return claimFromRow(row);
  }

  claimForRun(run: RunRef): Claim {
    const row = this.#db
      .select()
      .from(claims)
      .where(eq(claims.run_ref, run))
      .orderBy(desc(claims.claimed_at))
      .limit(1)
      .get();
    if (!row) throw new Error(`Claim not found for run: ${run}`);
    return claimFromRow(row);
  }

  steps(run: RunRef) {
    return this.#db
      .select({
        state: transactionSteps.state,
        receipt_json: transactionSteps.receipt_json,
        error_text: transactionSteps.error_text,
        occurred_at: transactionSteps.occurred_at,
      })
      .from(transactionSteps)
      .where(eq(transactionSteps.run_ref, run))
      .orderBy(asc(transactionSteps.id))
      .all();
  }

  pendingWrite(run: RunRef): { id: number; receipt: unknown } | undefined {
    const row = this.#db
      .select({
        id: transactionSteps.id,
        state: transactionSteps.state,
        receipt_json: transactionSteps.receipt_json,
      })
      .from(transactionSteps)
      .where(
        and(
          eq(transactionSteps.run_ref, run),
          inArray(transactionSteps.state, ["write_pending", "write_completed"]),
        ),
      )
      .orderBy(desc(transactionSteps.id))
      .limit(1)
      .get();
    return row?.state === "write_pending" && row.receipt_json
      ? { id: row.id, receipt: JSON.parse(row.receipt_json) }
      : undefined;
  }

  beginWrite(run: RunRef, receipt: unknown): number {
    return this.#database
      .transaction(() => {
        if (this.pendingWrite(run))
          throw new Error("An unfinished write requires verified readback");
        this.recordStep(run, "write_pending", receipt);
        const pending = this.pendingWrite(run);
        if (!pending) throw new Error("Pending write was not recorded");
        return pending.id;
      })
      .immediate();
  }

  completeWrite(run: RunRef, id: number): void {
    this.#transaction(() => {
      const pending = this.pendingWrite(run);
      if (pending?.id !== id)
        throw new Error("Pending write changed before completion was recorded");
      this.recordStep(run, "write_completed", { id });
    });
  }

  #recordRecovery(run: RunRef, outcome: string, evidence: unknown): void {
    this.#db
      .insert(recoveryEvidence)
      .values({
        run_ref: run,
        outcome,
        evidence_json: JSON.stringify(evidence),
        occurred_at: new Date().toISOString(),
      })
      .run();
  }

  recoveryEvidence(run: RunRef) {
    return this.#db
      .select({
        outcome: recoveryEvidence.outcome,
        evidence_json: recoveryEvidence.evidence_json,
        occurred_at: recoveryEvidence.occurred_at,
      })
      .from(recoveryEvidence)
      .where(eq(recoveryEvidence.run_ref, run))
      .orderBy(asc(recoveryEvidence.id))
      .all();
  }

  saveLane(lane: Lane): void {
    const values = {
      id: lane.id,
      ticket: lane.ticket ?? null,
      title: lane.title ?? null,
      run_ref: lane.run ?? null,
      claim_ref: lane.claim ?? null,
      state: lane.state,
      previous_state: lane.previousState ?? null,
      attention_reason: lane.attentionReason ?? null,
      artifact: lane.artifact ?? null,
      head: lane.head ?? null,
      evidence_json: JSON.stringify(lane.evidence),
      verdict_json: lane.verdict ? JSON.stringify(lane.verdict) : null,
      review_round: lane.reviewRound,
      max_review_rounds: lane.maxReviewRounds,
      created_at: lane.createdAt,
      updated_at: lane.updatedAt,
    };
    this.#db
      .insert(lanes)
      .values(values)
      .onConflictDoUpdate({
        target: lanes.id,
        set: {
          ticket: values.ticket,
          title: values.title,
          run_ref: values.run_ref,
          claim_ref: values.claim_ref,
          state: values.state,
          previous_state: values.previous_state,
          attention_reason: values.attention_reason,
          artifact: values.artifact,
          head: values.head,
          evidence_json: values.evidence_json,
          verdict_json: values.verdict_json,
          review_round: values.review_round,
          max_review_rounds: values.max_review_rounds,
          updated_at: values.updated_at,
        },
      })
      .run();
  }

  lane(id: LaneRef): Lane {
    const row = this.#db.select().from(lanes).where(eq(lanes.id, id)).get();
    if (!row) throw new Error(`Lane not found: ${id}`);
    return laneFromRow(row);
  }

  findLane(id: LaneRef): Lane | undefined {
    const row = this.#db.select().from(lanes).where(eq(lanes.id, id)).get();
    return row ? laneFromRow(row) : undefined;
  }

  listLanes(): Lane[] {
    const rows = this.#db.select().from(lanes).orderBy(desc(lanes.created_at)).all();
    return rows.map(laneFromRow);
  }

  laneForTicket(ticket: string): Lane | undefined {
    const row = this.#db
      .select()
      .from(lanes)
      .where(eq(lanes.ticket, ticket))
      .orderBy(desc(lanes.created_at))
      .limit(1)
      .get();
    return row ? laneFromRow(row) : undefined;
  }

  listRuns(): Run[] {
    const rows = this.#db.select({ ref: runs.ref }).from(runs).orderBy(desc(runs.created_at)).all();
    return rows.map(({ ref }) => this.run(runRefSchema.parse(ref)));
  }

  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void {
    this.#db
      .insert(transactionSteps)
      .values({
        run_ref: run,
        state,
        receipt_json: receipt === undefined ? null : JSON.stringify(receipt),
        error_text: error === undefined ? null : errorMessage(error),
        occurred_at: new Date().toISOString(),
      })
      .run();
  }

  #transaction(operation: () => void): void {
    this.#database.transaction(operation)();
  }
}

function claimFromRow(row: typeof claims.$inferSelect): Claim {
  return {
    ref: claimRefSchema.parse(row.ref),
    ticket: ticketRefSchema.parse(row.ticket),
    humanOwner: actorRefSchema.parse(row.human_owner),
    run: runRefSchema.parse(row.run_ref),
    previousState: JSON.parse(row.previous_state_json),
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    status: z.enum(["active", "released"]).parse(row.status),
    ...(row.current_version ? { currentVersion: row.current_version } : {}),
    ...(row.claim_home ? { claimHome: row.claim_home } : {}),
    ...(row.claim_home_url ? { claimHomeUrl: row.claim_home_url } : {}),
    ...(row.record_version ? { recordVersion: row.record_version } : {}),
    ...(row.lock_ref ? { lockRef: row.lock_ref } : {}),
    ...(row.config_commit ? { configCommit: row.config_commit } : {}),
  };
}

const laneStates = [
  "queued",
  "claimed",
  "implementing",
  "submitted",
  "reviewing",
  "approved",
  "merged",
  "done",
  "attention",
] as const satisfies readonly LaneState[];

function laneFromRow(row: typeof lanes.$inferSelect): Lane {
  return {
    id: laneRefSchema.parse(row.id),
    ...(row.ticket ? { ticket: ticketRefSchema.parse(row.ticket) } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.run_ref ? { run: runRefSchema.parse(row.run_ref) } : {}),
    ...(row.claim_ref ? { claim: claimRefSchema.parse(row.claim_ref) } : {}),
    state: z.enum(laneStates).parse(row.state),
    ...(row.previous_state ? { previousState: z.enum(laneStates).parse(row.previous_state) } : {}),
    ...(row.attention_reason ? { attentionReason: row.attention_reason } : {}),
    ...(row.artifact ? { artifact: row.artifact } : {}),
    ...(row.head ? { head: row.head } : {}),
    evidence: JSON.parse(row.evidence_json),
    ...(row.verdict_json ? { verdict: JSON.parse(row.verdict_json) } : {}),
    reviewRound: row.review_round,
    maxReviewRounds: row.max_review_rounds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
