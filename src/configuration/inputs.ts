import { z } from "zod";
import { configText, personalSettingsSchema } from "./schema.ts";

const path = configText
  .describe("Project configuration file; defaults to interlock.toml in the current directory.")
  .meta({ metavar: "FILE" });
const setting = z
  .enum([...personalSettingsSchema.keyof().options, "claim-home"])
  .describe("Personal setting, or the user-level claim-home")
  .meta({ metavar: "SETTING" });
export const initInput = {
  path: path.optional(),
  from: path.describe("Copy an explicitly selected project configuration file.").optional(),
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
    .describe(
      "Save one explicit personal choice in local SQLite, or set the user-level claim-home; never supply secrets.",
    )
    .optional(),
  follow: z
    .enum([...personalSettingsSchema.keyof().options, "all"])
    .describe("Follow a project setting, or use all to clear every personal choice.")
    .meta({ metavar: "SETTING" })
    .optional(),
};
export type InitConfigurationInput = z.output<z.ZodObject<typeof initInput>>;
export type ShowConfigurationInput = z.output<z.ZodObject<typeof showInput>>;
export type EditConfigurationInput = z.output<z.ZodObject<typeof editInput>>;
