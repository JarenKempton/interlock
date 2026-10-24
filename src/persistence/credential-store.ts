import type { CommandResult } from "../adapters/workspaces/git.ts";

export interface CredentialStore {
  read(name: string): Promise<string | undefined>;
  write(name: string, secret: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export type SecretCommand = (argv: readonly string[], stdin?: string) => Promise<CommandResult>;

const SERVICE = "interlock";

export const spawnSecretCommand: SecretCommand = async (argv, stdin) => {
  const child = Bun.spawn([...argv], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export function osCredentialStore(
  platform: NodeJS.Platform = process.platform,
  command: SecretCommand = spawnSecretCommand,
): CredentialStore {
  const run = async (argv: readonly string[], stdin?: string) => {
    try {
      return await command(argv, stdin);
    } catch {
      throw new Error(`${storeName(platform)} is unavailable: ${argv[0]} could not run`);
    }
  };
  const checked = async (argv: readonly string[], stdin?: string) => {
    const result = await run(argv, stdin);
    if (result.exitCode !== 0)
      throw new Error(`${storeName(platform)} ${argv[1] ?? argv[0]} failed (${result.exitCode})`);
    return result.stdout;
  };
  if (platform === "darwin")
    return {
      async read(name) {
        const result = await run(macCommand("find-generic-password", name, ["-w"]));
        return result.exitCode === 0 ? result.stdout.replace(/\n$/, "") : undefined;
      },
      async write(name, secret) {
        const hex = Buffer.from(secret, "utf8").toString("hex");
        const line = [...macCommand("add-generic-password", name, ["-U", "-X", hex])].slice(1);
        await checked(["security", "-i"], `${line.join(" ")}\n`);
      },
      async delete(name) {
        await run(macCommand("delete-generic-password", name));
      },
    };
  if (platform === "win32")
    return {
      async read(name) {
        const output = (await checked(windowsCommand("read", name))).trim();
        return output ? Buffer.from(output, "base64").toString("utf8") : undefined;
      },
      async write(name, secret) {
        await checked(
          windowsCommand("write", name),
          Buffer.from(secret, "utf8").toString("base64"),
        );
      },
      async delete(name) {
        await checked(windowsCommand("delete", name));
      },
    };
  const attributes = (name: string) => ["service", SERVICE, "account", account(name)];
  return {
    async read(name) {
      const result = await run(["secret-tool", "lookup", ...attributes(name)]);
      return result.exitCode === 0 && result.stdout ? result.stdout : undefined;
    },
    async write(name, secret) {
      await checked(
        ["secret-tool", "store", `--label=Interlock ${account(name)}`, ...attributes(name)],
        secret,
      );
    },
    async delete(name) {
      await run(["secret-tool", "clear", ...attributes(name)]);
    },
  };
}

function storeName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "Linux Secret Service (secret-tool)";
}

function account(name: string): string {
  if (!/^[\w.:@-]+$/.test(name)) throw new Error("Credential name has unsupported characters");
  return name;
}

function macCommand(operation: string, name: string, extra: readonly string[] = []): string[] {
  return ["security", operation, "-s", SERVICE, "-a", account(name), ...extra];
}

function windowsCommand(operation: "read" | "write" | "delete", name: string): string[] {
  const script = `${WINDOWS_CREDENTIALS}\n[InterlockCredential]::${operation}('${SERVICE}:${account(name)}')`;
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

const WINDOWS_CREDENTIALS = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InterlockCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref Credential credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  private const int Generic = 1;
  private const int NotFound = 1168;
  public static void read(string target) {
    IntPtr pointer;
    if (!CredReadW(target, Generic, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == NotFound) return;
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] blob = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
      Console.Out.Write(Convert.ToBase64String(blob));
    } finally {
      CredFree(pointer);
    }
  }
  public static void write(string target) {
    byte[] blob = Convert.FromBase64String(Console.In.ReadToEnd().Trim());
    Credential credential = new Credential();
    credential.Type = Generic;
    credential.TargetName = target;
    credential.UserName = target;
    credential.Persist = 2;
    credential.CredentialBlobSize = blob.Length;
    credential.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
      if (!CredWriteW(ref credential, 0))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(credential.CredentialBlob);
    }
  }
  public static void delete(string target) {
    if (!CredDeleteW(target, Generic, 0) && Marshal.GetLastWin32Error() != NotFound)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@`;
