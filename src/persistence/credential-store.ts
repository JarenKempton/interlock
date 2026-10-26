export interface CredentialStore {
  read(name: string): Promise<string | undefined>;
  write(name: string, secret: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const STORE =
  process.platform === "darwin"
    ? "macOS Keychain"
    : process.platform === "win32"
      ? "Windows Credential Manager"
      : "Linux Secret Service";

export function osCredentialStore(service = "interlock"): CredentialStore {
  const call = async <T>(
    name: string,
    operation: (key: { service: string; name: string }) => Promise<T>,
  ) => {
    const key = { service, name: account(name) };
    try {
      return await operation(key);
    } catch {
      throw new Error(`${STORE} is unavailable`);
    }
  };
  return {
    read: async (name) => (await call(name, (key) => Bun.secrets.get(key))) ?? undefined,
    write: (name, value) => call(name, (key) => Bun.secrets.set({ ...key, value })),
    delete: async (name) => {
      await call(name, (key) => Bun.secrets.delete(key));
    },
  };
}

function account(name: string): string {
  if (!/^[\w.:@-]+$/.test(name)) throw new Error("Credential name has unsupported characters");
  return name;
}
