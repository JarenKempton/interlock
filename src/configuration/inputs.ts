import { z } from "zod";
import { CHOICE_KEYS, configText } from "./schema.ts";

const path = configText
  .describe("Shared configuration file; defaults to interlock.toml in the current directory.")
  .meta({ metavar: "FILE" });
const setting = z
  .enum([...CHOICE_KEYS, "jira_site", "claim-home"])
  .describe("User setting")
  .meta({ metavar: "SETTING" });
export const initInput = {
  path: path.optional(),
  from: path.describe("Copy an explicitly selected shared configuration file.").optional(),
};
export const showInput = { path: path.optional() };
export const editInput = {
  path: path.optional(),
  editor: configText
    .describe("Editor executable; defaults to VISUAL or EDITOR.")
    .meta({ metavar: "EXECUTABLE" })
    .optional(),
  set: z
    .tuple([setting, configText.meta({ metavar: "VALUE" })])
    .describe("Save one user setting in local SQLite; never supply secrets.")
    .optional(),
  follow: z
    .enum([...CHOICE_KEYS, "all"])
    .describe("Clear a user setting so shared config or the default applies; all clears every one.")
    .meta({ metavar: "SETTING" })
    .optional(),
};
export type InitConfigurationInput = z.output<z.ZodObject<typeof initInput>>;
export type ShowConfigurationInput = z.output<z.ZodObject<typeof showInput>>;
export type EditConfigurationInput = z.output<z.ZodObject<typeof editInput>>;
