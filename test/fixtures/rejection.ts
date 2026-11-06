export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Rejected with a non-error: ${String(error)}`);
  }
  throw new Error("Expected a rejection");
}
