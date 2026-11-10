import { expect } from "bun:test";

export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Rejected with a non-error: ${String(error)}`);
  }
  throw new Error("Expected a rejection");
}

export function expectRejection(promise: Promise<unknown>) {
  const rejects = expect(promise).rejects;
  return {
    toThrow: (expected?: unknown) => Promise.resolve(rejects.toThrow(expected)),
    toBeInstanceOf: (expected: unknown) => Promise.resolve(rejects.toBeInstanceOf(expected)),
    toMatchObject: (expected: object) => Promise.resolve(rejects.toMatchObject(expected)),
    not: {
      toBeInstanceOf: (expected: unknown) => Promise.resolve(rejects.not.toBeInstanceOf(expected)),
    },
  };
}
