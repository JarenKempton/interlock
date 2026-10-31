import { defineAction } from "../cli/definition.ts";
import { editInput, initInput, showInput } from "./inputs.ts";
import {
  type ConfigurationPlatformOptions,
  configurationOperations,
  validateConfigurationOutput,
} from "./project-files.ts";

export function configurationActions(platform: ConfigurationPlatformOptions) {
  const operations = configurationOperations(platform);
  return {
    init: defineAction({
      description:
        "Create a shared interlock.toml without overwriting a file; show the resolved settings.",
      input: initInput,
      handler: operations.init,
      output: validateConfigurationOutput,
    }),
    config: {
      show: defineAction({
        description: "Show resolved settings and their sources without changing durable state.",
        input: showInput,
        handler: operations.show,
        output: validateConfigurationOutput,
      }),
      edit: defineAction({
        description:
          "Set or clear a user setting, or edit the shared interlock.toml through a staged file.",
        input: editInput,
        validate(input) {
          if (
            [input.editor, input.set, input.follow].filter((value) => value !== undefined).length >
            1
          )
            throw new Error("Choose one of --editor, --set, or --follow");
        },
        handler: operations.edit,
        output: validateConfigurationOutput,
      }),
    },
  };
}
