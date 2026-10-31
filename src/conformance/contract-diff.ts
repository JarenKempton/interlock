type Schema = Record<string, unknown>;

const DOCUMENTATION = new Set(["description", "title", "metavar", "examples", "$schema"]);
const NARROWING = [
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "multipleOf",
  "const",
];
const HANDLED = new Set([
  ...DOCUMENTATION,
  ...NARROWING,
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "oneOf",
  "default",
]);

function schema(value: unknown): Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function key(value: unknown): string {
  return JSON.stringify(value);
}

function discriminator(option: unknown, name: string): string | undefined {
  const object = schema(option);
  const property = schema(schema(object.properties)[name]);
  return object.type === "object" &&
    list(object.required).includes(name) &&
    property.const !== undefined
    ? key(property.const)
    : undefined;
}

function disjoint(options: unknown[]): boolean {
  const names = Object.keys(schema(schema(options[0]).properties));
  return names.some((name) => {
    const values = options.map((option) => discriminator(option, name));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
}

export function breakingChanges(
  before: unknown,
  after: unknown,
  path = "$",
  output = false,
): string[] {
  if (key(before) === key(after)) return [];
  if (
    [before, after].some(
      (value) =>
        value !== undefined &&
        typeof value !== "boolean" &&
        (value === null || typeof value !== "object" || Array.isArray(value)),
    )
  )
    return [`${path}: unsupported schema change`];
  if (typeof before === "boolean" || typeof after === "boolean") {
    if (after === false && before !== false) return [`${path}: schema closed`];
    if (output && before === false) return [`${path}: output schema widened`];
    if (before === false || after === true) {
      if (!output) return [];
    }
    return breakingChanges(
      before === true ? {} : before,
      after === true ? {} : after,
      path,
      output,
    );
  }
  const old = schema(before);
  const next = schema(after);
  const changes: string[] = [];
  const oldTypes = list(old.type).map(key);
  const newTypes = new Set(list(next.type).map(key));
  if (newTypes.size > 0)
    for (const type of oldTypes.length > 0 ? oldTypes : ["any"])
      if (!newTypes.has(type)) changes.push(`${path}: type ${type} narrowed`);
  if (next.enum !== undefined) {
    const values = new Set(list(next.enum).map(key));
    if (old.enum === undefined) changes.push(`${path}: enum added`);
    for (const value of list(old.enum).map(key))
      if (!values.has(value)) changes.push(`${path}: enum value ${value} removed`);
  }
  for (const keyword of NARROWING)
    if (next[keyword] !== undefined && key(next[keyword]) !== key(old[keyword]))
      changes.push(`${path}: ${keyword} narrowed`);
  const oldProperties = schema(old.properties);
  const newProperties = schema(next.properties);
  for (const name of Object.keys(oldProperties)) {
    if (!Object.hasOwn(newProperties, name)) changes.push(`${path}.${name}: removed`);
    else
      changes.push(
        ...breakingChanges(oldProperties[name], newProperties[name], `${path}.${name}`, output),
      );
  }
  const required = new Set(list(old.required).map(key));
  for (const name of list(next.required))
    if (!required.has(key(name))) changes.push(`${path}.${String(name)}: newly required`);
  if (output) {
    const nextRequired = new Set(list(next.required).map(key));
    for (const name of list(old.required))
      if (!nextRequired.has(key(name)))
        changes.push(`${path}.${String(name)}: output no longer required`);
    const scalar = (value: Schema) =>
      Object.fromEntries(
        ["type", "enum", ...NARROWING]
          .filter((name) => value[name] !== undefined)
          .map((name) => [name, value[name]]),
      );
    changes.push(...breakingChanges(scalar(next), scalar(old), `${path}: output widened`));
  }
  if (next.additionalProperties === false && old.additionalProperties !== false)
    changes.push(`${path}: additional properties closed`);
  else if (old.additionalProperties !== undefined || next.additionalProperties !== undefined)
    changes.push(
      ...breakingChanges(
        old.additionalProperties === undefined ? true : old.additionalProperties,
        next.additionalProperties === undefined ? true : next.additionalProperties,
        `${path}.*`,
        output,
      ),
    );
  if (old.items !== undefined || next.items !== undefined)
    changes.push(
      ...breakingChanges(
        old.items === undefined ? true : old.items,
        next.items === undefined ? true : next.items,
        `${path}[]`,
        output,
      ),
    );
  for (const union of ["anyOf", "oneOf"]) {
    const options = list(next[union]);
    const previous = list(old[union]);
    if (
      union === "oneOf" &&
      key(old[union]) !== key(next[union]) &&
      !(disjoint(previous) && disjoint(options))
    ) {
      changes.push(`${path}: unclassified change to oneOf`);
      continue;
    }
    for (const [index, option] of previous.entries()) {
      if (
        options.some((candidate) => breakingChanges(option, candidate, path, output).length === 0)
      )
        continue;
      const counterpart = options.find((candidate) =>
        Object.keys(schema(schema(option).properties)).some((name) => {
          const value = discriminator(option, name);
          return value !== undefined && value === discriminator(candidate, name);
        }),
      );
      changes.push(
        ...(counterpart === undefined
          ? [`${path}: ${union} option ${index} removed`]
          : breakingChanges(option, counterpart, `${path}|${index}`, output)),
      );
    }
    if (output)
      for (const [index, option] of options.entries())
        if (
          !previous.some(
            (candidate) => breakingChanges(candidate, option, path, output).length === 0,
          )
        )
          changes.push(`${path}: output ${union} option ${index} added`);
    if (old[union] === undefined && next[union] !== undefined)
      changes.push(`${path}: ${union} added`);
  }
  for (const keyword of new Set([...Object.keys(old), ...Object.keys(next)]))
    if (!HANDLED.has(keyword) && key(old[keyword]) !== key(next[keyword]))
      changes.push(`${path}: unclassified change to ${keyword}`);
  return changes;
}

export function contractBreakingChanges(before: unknown, after: unknown): string[] {
  const old = schema(before);
  const next = schema(after);
  return Object.keys(old).flatMap((name) =>
    Object.hasOwn(next, name)
      ? breakingChanges(old[name], next[name], name, name === "output")
      : [`${name}: removed`],
  );
}
