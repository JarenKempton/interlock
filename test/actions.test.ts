import { expect, test } from "bun:test";
import { z } from "zod";
import { createApplication } from "../src/application.ts";
import { composeActions, registeredActions } from "../src/cli/catalog.ts";
import { actionHelp, dispatch } from "../src/cli/command-line.ts";
import { completionCandidates } from "../src/cli/completions.ts";
import { defineAction } from "../src/cli/definition.ts";
import { manPage } from "../src/cli/manpage.ts";
import { optional, positional, text } from "../src/cli/schema.ts";

function example(greet: (name: string) => string) {
  return {
    sample: {
      greet: defineAction({
        description: "Greet through the actually supplied service.",
        input: {
          name: positional(text("Person to greet.", "NAME")),
          punctuation: optional(text("Ending punctuation.", "TEXT")),
        },
        handler: (input) => greet(input.name) + (input.punctuation ?? "!"),
      }),
    },
  };
}

test("one added action supplies typed calls, CLI dispatch, help, manual and completions", async () => {
  const app = example((name) => `Hello ${name}`);
  expect(await app.sample.greet.execute({ name: "Jaren" })).toBe("Hello Jaren!");
  const output: string[] = [];
  await dispatch(app, ["sample", "greet", "Jaren", "--punctuation", "."], (line) =>
    output.push(line),
  );
  expect(output).toEqual(["Hello Jaren."]);
  expect(actionHelp(app, ["sample", "greet"])).toContain("sample greet");
  expect(actionHelp(app, ["sample", "greet"])).toContain("--punctuation TEXT");
  expect(manPage("test", app)).toContain("Greet through the actually supplied service.");
  expect(completionCandidates(app, [])).toEqual(["sample"]);
  expect(completionCandidates(app, ["sample"])).toEqual(["greet"]);
  expect(completionCandidates(app, ["sample", "greet"])).toContain("--punctuation");
  const json = JSON.parse(actionHelp(app, [], true));
  expect(json.actions[0].input.punctuation.values).toEqual(["TEXT"]);
});

test.each(
  [
    ["sample", "greet", "Jaren", "--unknown"],
    ["sample", "greet", "Jaren", "--punctuation"],
    ["sample", "greet", "Jaren", "--punctuation", "!", "--punctuation", "?"],
    ["sample", "greet"],
    ["sample", "greet", "Jaren", "unexpected"],
  ].map((args) => ({ args })),
)("shared parser rejects malformed inputs before handlers: %j", async ({ args }) => {
  let calls = 0;
  await expect(
    dispatch(
      example((name) => {
        calls++;
        return name;
      }),
      args,
      () => {},
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("direct typed calls also validate untrusted inputs at runtime", async () => {
  let calls = 0;
  const action = example((name) => {
    calls++;
    return name;
  }).sample.greet;
  await expect(action.invoke({ name: 17 })).rejects.toThrow("Invalid name");
  await expect(action.invoke({ name: "Jaren", unknown: "DO_NOT_ECHO" })).rejects.toThrow(
    "Unknown action input field",
  );
  expect(calls).toBe(0);
});

test("current completion queries derive subcommands and options from the live tree", async () => {
  const app = createApplication();
  expect(actionHelp(app, ["completions"])).toContain("--at PREFIX");
  expect(await app.completions.execute({ shell: "bash", at: "config" })).toBe("show\nedit");
  expect(await app.completions.execute({ shell: "bash", at: "config edit" })).toContain("--follow");
  expect(await app.completions.execute({ shell: "bash", at: "" })).not.toContain("stop");
  expect(registeredActions(app).some((entry) => entry.command.join(" ") === "pickup")).toBe(true);
});

// These compile-only examples fail typecheck if action/input/dependency types become permissive.
export function actionTypeChecks(app: ReturnType<typeof createApplication>) {
  // @ts-expect-error Action names must exist on the application.
  void app.config.shwo.execute({});
  // @ts-expect-error show has no editor option.
  void app.config.show.execute({ editor: "vi" });
  // @ts-expect-error personal setting keys come from the setting schema.
  void app.config.edit.execute({ set: ["unknown", "value"] });
  // @ts-expect-error required positional input cannot be omitted.
  void app.stop.execute({});
  const action = example((name) => name).sample.greet;
  // @ts-expect-error handler result is inferred as a string, not a number.
  const result: Promise<number> = action.execute({ name: "Jaren" });
  return result;
}

test("duplicate registrations cannot silently overwrite an action", () => {
  const app = example((name) => name);
  expect(() => {
    // @ts-expect-error Duplicate registration is rejected by typecheck and at the untyped boundary.
    composeActions(app, app);
  }).toThrow("Duplicate action registration");
});

test("Optique completes schema enum values through the real shell transport without invoking actions", async () => {
  const app = createApplication({
    configuration: { cwd: "/unused", statePath: "/unused/state.db" },
  });
  const output: string[] = [];
  await dispatch(app, ["--complete", "bash", "config", "edit", "--follow", ""], (text) =>
    output.push(text),
  );
  expect(output.join("").split("\n").filter(Boolean)).toEqual([
    "host",
    "agent",
    "model",
    "effort",
    "context_window",
    "runtime_mode",
    "interaction_mode",
    "all",
  ]);
  expect(actionHelp(app, ["config", "edit"])).toContain("--set SETTING VALUE");
});

test("library parsing preserves spaces and equals syntax while diagnostics redact values", async () => {
  const app = example((name) => name);
  const output: string[] = [];
  await dispatch(app, ["sample", "greet", "two words", "--punctuation=?"], (text) =>
    output.push(text),
  );
  expect(output).toEqual(["two words?"]);
  try {
    await dispatch(app, ["sample", "greet", "DO_NOT_ECHO", "--secret=DO_NOT_ECHO"], () => {});
    throw new Error("Expected rejection");
  } catch (error) {
    expect(String(error)).toContain("Invalid arguments");
    expect(String(error)).not.toContain("DO_NOT_ECHO");
  }
});

test("CLI and typed invocation apply Zod transforms exactly once, including changed output types", async () => {
  let calls = 0;
  const action = defineAction({
    description: "Transform once",
    input: {
      value: z.string().transform((value) => {
        calls++;
        return `${value}!`;
      }),
      count: z.string().transform(Number),
    },
    handler: (input) => input,
  });
  expect(calls).toBe(0);
  expect(await action.execute({ value: "hello", count: "4" })).toEqual({
    value: "hello!",
    count: 4,
  });
  const output: string[] = [];
  await dispatch(
    { sample: action },
    ["sample", "--value", "hello", "--count", "4", "--json"],
    (line) => output.push(line),
  );
  expect(JSON.parse(output[0] ?? "")).toEqual({ value: "hello!", count: 4 });
  actionHelp({ sample: action });
  completionCandidates({ sample: action }, ["sample"]);
  expect(calls).toBe(2);
  const typeChecks = () => {
    // @ts-expect-error execute accepts the schema's input, not its transformed output.
    void action.execute({ value: "hello", count: 4 });
  };
  void typeChecks;
});

test("schema defaults agree across typed calls, CLI and JSON help", async () => {
  const action = defineAction({
    description: "Defaults",
    input: { name: z.string().default("world"), enabled: z.boolean().default(true) },
    handler: (input) => input,
  });
  const output: string[] = [];
  await dispatch({ sample: action }, ["sample"], (line) => output.push(line));
  expect(JSON.parse(output[0] ?? "")).toEqual(await action.execute({}));
  expect(JSON.parse(output[0] ?? "")).toEqual({ name: "world", enabled: true });
  const help = JSON.parse(actionHelp({ sample: action }, [], true));
  expect(help.actions[0].input.name.required).toBe(false);
  expect(help.actions[0].input.enabled.required).toBe(false);
});

test("help respects end-of-options, accepts omitted required fields, and shares usage flags", async () => {
  let calls = 0;
  const action = defineAction({
    description: "Echo",
    input: { value: positional(text("Literal", "VALUE")) },
    handler: ({ value }) => {
      calls++;
      return value;
    },
  });
  const output: string[] = [];
  await dispatch({ echo: action }, ["echo", "--", "--help"], (line) => output.push(line));
  expect(output).toEqual(["--help"]);
  await dispatch({ echo: action }, ["echo", "--help", "--json"], (line) => output.push(line));
  const help = JSON.parse(output[1] ?? "");
  expect(help.usage).toContain("--help");
  expect(help.usage).toContain("--json");
  expect(calls).toBe(1);
  await expect(dispatch({ echo: action }, ["echo"], () => {})).rejects.toThrow(help.usage);
});
