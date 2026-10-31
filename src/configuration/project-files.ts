import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { normalizeClaimHome } from "../domain/claim-home.ts";
import { databasePath } from "../persistence/paths.ts";
import { StateStore } from "../persistence/state.ts";
import INITIAL_CONFIGURATION from "./default.toml" with { type: "text" };
import { configurationVersion, parseProjectToml, projectConfigPath } from "./files.ts";
import type {
  EditConfigurationInput,
  InitConfigurationInput,
  ShowConfigurationInput,
} from "./inputs.ts";
import { readUserSettings } from "./local-settings.ts";
import {
  CHOICE_KEYS,
  type ResolvedConfiguration,
  resolveConfiguration,
  type UserSettings,
  validateResolvedConfiguration,
} from "./schema.ts";

export { INITIAL_CONFIGURATION };
export interface ConfigurationOutput {
  version: 2;
  action: "initialized" | "configuration" | "edited";
  path: string;
  configuration: ResolvedConfiguration;
}
export function validateConfigurationOutput(output: unknown): ConfigurationOutput {
  const parsed = z
    .object({
      version: z.literal(2),
      action: z.enum(["initialized", "configuration", "edited"]),
      path: z.string(),
      configuration: z.unknown(),
    })
    .safeParse(output);
  if (!parsed.success) throw new Error("Invalid configuration result");
  return {
    ...parsed.data,
    configuration: validateResolvedConfiguration(parsed.data.configuration),
  };
}
export interface ConfigurationPlatformOptions {
  cwd: string;
  statePath?: string;
  editor?: string;
  editFile?: (argv: string[]) => Promise<number>;
}
export function sharedConfiguration(path: string, explicit: boolean): string | undefined {
  if (!explicit && !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}
export function resolveSharedConfiguration(
  path: string,
  content: string | undefined,
  user: UserSettings,
): ResolvedConfiguration {
  return content === undefined
    ? resolveConfiguration(undefined, user)
    : resolveConfiguration(parseProjectToml(content), user, {
        path,
        version: configurationVersion(content),
      });
}
export function configurationOperations(options: ConfigurationPlatformOptions) {
  const pathFor = (input: { path?: string | undefined }) =>
    projectConfigPath(options.cwd, input.path);
  const storePath = () => options.statePath ?? databasePath();
  const resolved = (
    path: string,
    content: string | undefined,
    user = readUserSettings(storePath()),
  ) => resolveSharedConfiguration(path, content, user);
  const output = (
    action: ConfigurationOutput["action"],
    path: string,
    configuration: ConfigurationOutput["configuration"],
  ): ConfigurationOutput => ({ version: 2, action, path, configuration });
  return {
    async init(input: InitConfigurationInput) {
      const path = pathFor(input);
      const content = input.from
        ? readFileSync(resolve(options.cwd, input.from), "utf8")
        : INITIAL_CONFIGURATION;
      const configuration = resolved(path, content);
      // wx rejects existing files and symlinks, including dangling symlinks.
      writeFileSync(resolve(options.cwd, input.path ?? "interlock.toml"), content, {
        flag: "wx",
        mode: 0o600,
      });
      return output("initialized", path, configuration);
    },
    async show(input: ShowConfigurationInput) {
      const path = pathFor(input);
      return output(
        "configuration",
        path,
        resolved(path, sharedConfiguration(path, input.path !== undefined)),
      );
    },
    async edit(input: EditConfigurationInput) {
      const path = pathFor(input);
      if (input.set || input.follow) {
        const content = sharedConfiguration(path, input.path !== undefined);
        const [name, value] = input.set ?? [];
        const update = (settings: UserSettings): UserSettings => {
          if (name === "claim-home") settings.claim_home = normalizeClaimHome(value ?? "").url;
          else if (name) settings[name] = value;
          for (const key of input.follow === "all"
            ? CHOICE_KEYS
            : input.follow
              ? [input.follow]
              : [])
            delete settings[key];
          return settings;
        };
        resolved(path, content, update(readUserSettings(storePath())));
        mkdirSync(dirname(storePath()), { recursive: true });
        const store = new StateStore(storePath());
        try {
          const user = store.updateUserSettings((settings) => {
            const next = update(settings);
            resolved(path, content, next);
            return next;
          });
          return output("edited", path, resolved(path, content, user));
        } finally {
          store.close();
        }
      }
      const original = readFileSync(path, "utf8");
      const editor = input.editor ?? options.editor ?? process.env.VISUAL ?? process.env.EDITOR;
      if (!editor)
        throw new Error(
          "config edit requires --editor EXECUTABLE, --set KEY VALUE, or --follow KEY",
        );
      const requestedPath = resolve(options.cwd, input.path ?? "interlock.toml");
      if (!lstatSync(requestedPath).isFile() || lstatSync(requestedPath).isSymbolicLink())
        throw new Error("Project edit requires a regular file, not a symlink");
      const staging = mkdtempSync(join(dirname(path), ".interlock-edit-"));
      const stagedPath = join(staging, "interlock.toml");
      try {
        writeFileSync(stagedPath, original, { mode: 0o600 });
        const argv = [editor, stagedPath];
        const code = options.editFile
          ? await options.editFile(argv)
          : await Bun.spawn(argv, {
              cwd: options.cwd,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }).exited;
        if (code !== 0) throw new Error("Editor failed; project configuration was preserved");
        const content = readFileSync(stagedPath, "utf8");
        const configuration = resolved(path, content);
        if (readFileSync(path, "utf8") !== original || lstatSync(path).isSymbolicLink())
          throw new Error("Project configuration changed during editing; refusing overwrite");
        renameSync(stagedPath, path);
        return output("edited", path, configuration);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Configuration edit failed";
        throw new Error(
          existsSync(stagedPath)
            ? `${reason}. Edited draft retained at ${stagedPath}`
            : `${reason}. No edited draft remains; project configuration was preserved`,
        );
      } finally {
        // A successful rename consumes the draft. Failed edits remain available for recovery.
        if (!existsSync(stagedPath)) rmSync(staging, { recursive: true, force: true });
      }
    },
  };
}
