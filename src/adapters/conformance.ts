import { z } from "zod";
import {
  AdapterClient,
  type AdapterDeadlineScheduler,
  AdapterProtocolError,
  type AdapterProtocolErrorCode,
} from "./protocol.ts";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  evidence: string;
}

export interface ConformanceReport {
  ok: boolean;
  executable: string;
  checks: ConformanceCheck[];
}

const CREDENTIAL_HANDLE = "credential-provider:conformance";

/**
 * Exercise the subprocess safety contract against an adapter
 * fixture that selects deliberate failure behavior with INTERLOCK_CONFORMANCE_SCENARIO.
 */
export async function runAdapterConformance(
  executable: string,
  coreVersion: string,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];

  const normal = client(executable, "normal");
  const description = await normal.initialize("tracker", "conformance:test", coreVersion);
  checks.push({
    name: "protocol negotiation",
    ok: description.protocol_versions.includes("1.0"),
    evidence: `${description.name}@${description.version} supports ${description.protocol_versions.join(", ")}`,
  });

  checks.push(
    await expectFailure("incompatible major is rejected", "invalid_response", async () => {
      await client(executable, "incompatible").initialize(
        "tracker",
        "conformance:incompatible",
        coreVersion,
      );
    }),
    await expectFailure(
      "unknown method",
      "rpc_error",
      async () => {
        await normal.call("conformance.unknown");
      },
      -32601,
    ),
    await deterministicTimeoutCheck(executable),
    await expectFailure("message limit terminates subprocess", "message_too_large", async () => {
      await client(executable, "oversized", { maxMessageSize: 256 }).call("conformance.probe");
    }),
    await expectFailure("crash is isolated", "process_exit", async () => {
      await client(executable, "crash").call("conformance.probe");
    }),
  );

  checks.push(await deterministicCancellationCheck(executable));

  const credential = await client(executable, "credential", {
    environment: { INTERLOCK_CREDENTIAL_HANDLE: CREDENTIAL_HANDLE },
  }).call(
    "conformance.probe",
    undefined,
    {},
    z.object({ handle: z.string(), argv: z.array(z.string()) }),
  );
  checks.push({
    name: "credential handle is environment-scoped",
    ok: credential.handle === CREDENTIAL_HANDLE && !credential.argv.includes(CREDENTIAL_HANDLE),
    evidence: "adapter received the provider handle through the environment, not argv",
  });

  const recovered = await client(executable, "normal").initialize(
    "tracker",
    "conformance:recovery",
    coreVersion,
  );
  checks.push({
    name: "fresh call survives prior failure",
    ok: recovered.name === description.name,
    evidence: "a fresh subprocess negotiated after timeout, cancellation, size failure, and crash",
  });

  return { ok: checks.every((check) => check.ok), executable, checks };
}

function client(
  executable: string,
  scenario: string,
  options: {
    timeoutMs?: number;
    maxMessageSize?: number;
    environment?: Record<string, string>;
    deadlineScheduler?: AdapterDeadlineScheduler;
  } = {},
) {
  const command = executable.endsWith(".ts") ? [process.execPath, executable] : executable;
  return new AdapterClient(command, {
    ...options,
    environment: { ...options.environment, INTERLOCK_CONFORMANCE_SCENARIO: scenario },
  });
}

class ManualDeadlineScheduler implements AdapterDeadlineScheduler {
  callback?: () => void;
  delayMs?: number;
  cancelled = false;

  schedule(callback: () => void, delayMs: number): () => void {
    this.callback = callback;
    this.delayMs = delayMs;
    return () => {
      this.cancelled = true;
    };
  }

  expire(): void {
    if (!this.callback) throw new Error("Adapter deadline was not scheduled");
    this.callback();
  }
}

async function deterministicTimeoutCheck(executable: string): Promise<ConformanceCheck> {
  const scheduler = new ManualDeadlineScheduler();
  const operation = client(executable, "hang", {
    timeoutMs: 30,
    deadlineScheduler: scheduler,
  }).call("conformance.probe");
  scheduler.expire();
  const check = await expectFailure("deadline terminates subprocess", "timeout", async () => {
    await operation;
  });
  return {
    ...check,
    ok: check.ok && scheduler.delayMs === 30 && scheduler.cancelled,
    evidence: check.ok
      ? `observed timeout through the scheduled ${scheduler.delayMs}ms deadline`
      : check.evidence,
  };
}

async function deterministicCancellationCheck(executable: string): Promise<ConformanceCheck> {
  const controller = new AbortController();
  const operation = client(executable, "hang").call("conformance.probe", undefined, {
    signal: controller.signal,
  });
  controller.abort();
  return expectFailure("cancellation terminates subprocess", "cancelled", async () => {
    await operation;
  });
}

async function expectFailure(
  name: string,
  code: AdapterProtocolErrorCode,
  operation: () => Promise<void>,
  rpcCode?: number,
): Promise<ConformanceCheck> {
  try {
    await operation();
    return { name, ok: false, evidence: "operation unexpectedly succeeded" };
  } catch (error) {
    const ok =
      error instanceof AdapterProtocolError &&
      error.code === code &&
      (rpcCode === undefined || error.rpcCode === rpcCode);
    return {
      name,
      ok,
      evidence: ok
        ? `observed ${code}${rpcCode === undefined ? "" : ` (${rpcCode})`}`
        : String(error),
    };
  }
}
