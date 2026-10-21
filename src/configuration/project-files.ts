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
import { databasePath } from "../persistence/paths.ts";
import { StateStore } from "../persistence/state.ts";
import INITIAL_CONFIGURATION from "./default.toml" with { type: "text" };
import { configurationVersion, parseProjectToml, projectConfigPath } from "./files.ts";
import type {
  EditConfigurationInput,
  InitConfigurationInput,
  ShowConfigurationInput,
} from "./inputs.ts";
import { readPersonalSettings } from "./local-settings.ts";
import {
  type PersonalSettings,
  type ResolvedConfiguration,
  resolveProjectConfiguration,
  validateResolvedConfiguration,
} from "./schema.ts";

export { INITIAL_CONFIGURATION };
export interface ConfigurationOutput {
  version: 1;
  action: "initialized" | "configuration" | "edited";
  path: string;
  configuration: ResolvedConfiguration;
}
export function validateConfigurationOutput(output: unknown): ConfigurationOutput {
  if (
    !output ||
    typeof output !== "object" ||
    !("configuration" in output) ||
    !("version" in output) ||
    output.version !== 1 ||
    !("path" in output) ||
    typeof output.path !== "string" ||
    !("action" in output) ||
    !["initialized", "configuration", "edited"].includes(String(output.action))
  )
    throw new Error("Invalid configuration result");
  validateResolvedConfiguration(output.configuration);
  return {
    version: 1,
    path: output.path,
    configuration: validateResolvedConfiguration(output.configuration),
    action: z.enum(["initialized", "configuration", "edited"]).parse(output.action),
  };
}
export interface ConfigurationPlatformOptions {
  cwd: string;
  statePath?: string;
  editor?: string;
  editFile?: (argv: string[]) => Promise<number>;
}
export function configurationOperations(options: ConfigurationPlatformOptions) {
  const pathFor = (input: { path?: string | undefined }) =>
    projectConfigPath(options.cwd, input.path);
  const storePath = () => options.statePath ?? databasePath();
  const resolved = (
    path: string,
    content: string,
    personal = readPersonalSettings(storePath(), path),
  ) =>
    resolveProjectConfiguration(parseProjectToml(content), personal, {
      path,
      version: configurationVersion(content),
    });
  const output = (
    action: ConfigurationOutput["action"],
    path: string,
    configuration: ConfigurationOutput["configuration"],
  ): ConfigurationOutput => ({ version: 1, action, path, configuration });
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
      return output("configuration", path, resolved(path, readFileSync(path, "utf8")));
    },
    async edit(input: EditConfigurationInput) {
      const path = pathFor(input);
      const original = readFileSync(path, "utf8");
      if (input.set || input.follow) {
        // Only explicit choices are persisted; defaults are always read from the project.
        const update = (settings: PersonalSettings) => {
          if (input.follow === "all") return {};
          if (input.set) settings[input.set[0]] = input.set[1];
          if (input.follow) delete settings[input.follow];
          return settings;
        };
        const candidate = update(readPersonalSettings(storePath(), path));
        resolved(path, original, candidate);
        mkdirSync(dirname(storePath()), { recursive: true });
        const store = new StateStore(storePath());
        try {
          const personal = store.updateConfigurationOverrides(path, (settings) => {
            const next = update(settings);
            resolved(path, original, next);
            return next;
          });
          return output("edited", path, resolved(path, original, personal));
        } finally {
          store.close();
        }
      }
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
