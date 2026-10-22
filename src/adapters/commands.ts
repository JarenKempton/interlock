import { defineAction } from "../cli/definition.ts";
import { positional, text } from "../cli/schema.ts";
import { builtInAdapters, findAdapter } from "./registry.ts";

export function adapterActions() {
  return {
    adapter: {
      list: defineAction({
        description: "Inspect discovered adapter capabilities.",
        input: {},
        handler: () => builtInAdapters(),
      }),
      describe: defineAction({
        description: "Inspect one adapter.",
        input: { name: positional(text("Adapter name.", "NAME")) },
        handler: (input) => findAdapter(input.name),
      }),
    },
  };
}
