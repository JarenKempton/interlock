import { defineAction } from "../cli/definition.ts";
import { editInput, initInput, showInput } from "./inputs.ts";
import {
  type ConfigurationPlatformOptions,
  configurationOperations,
  configurationOutputSchema,
} from "./project-files.ts";

export function configurationActions(platform: ConfigurationPlatformOptions) {
  const operations = configurationOperations(platform);
  return {
    init: defineAction({
      description:
        "Create project configuration without overwriting a file; show resolved defaults and requirements.",
      input: initInput,
      result: configurationOutputSchema,
      handler: operations.init,
    }),
    config: {
      show: defineAction({
        description:
          "Read project configuration and explicit personal choices without changing durable state.",
        input: showInput,
        result: configurationOutputSchema,
        handler: operations.show,
      }),
      edit: defineAction({
        description:
          "Edit a staged project file, set a personal choice, or follow the current project default.",
        input: editInput,
        validate(input) {
          if (
            [input.editor, input.set, input.follow].filter((value) => value !== undefined).length >
            1
          )
            throw new Error("Choose one of --editor, --set, or --follow");
        },
        result: configurationOutputSchema,
        handler: operations.edit,
      }),
    },
  };
}
