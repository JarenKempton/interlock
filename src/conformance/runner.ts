export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export interface ConformanceResult {
  name: string;
  ok: boolean;
  error?: string;
}

export async function runConformance(cases: readonly ConformanceCase[]) {
  const results: ConformanceResult[] = [];
  for (const item of cases) {
    try {
      await item.run();
      results.push({ name: item.name, ok: true });
    } catch (error) {
      results.push({
        name: item.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: results.every((result) => result.ok), results };
}

export function requireBehavior(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function requireRejection(operation: () => Promise<unknown>, code: string) {
  try {
    await operation();
  } catch (error) {
    requireBehavior(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`Operation succeeded instead of refusing with ${code}`);
}
