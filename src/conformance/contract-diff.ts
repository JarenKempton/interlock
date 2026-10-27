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

export function breakingChanges(before: unknown, after: unknown, path = "$"): string[] {
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
      changes.push(...breakingChanges(oldProperties[name], newProperties[name], `${path}.${name}`));
  }
  const required = new Set(list(old.required).map(key));
  for (const name of list(next.required))
    if (!required.has(key(name))) changes.push(`${path}.${String(name)}: newly required`);
  if (next.additionalProperties === false && old.additionalProperties !== false)
    changes.push(`${path}: additional properties closed`);
  else if (old.additionalProperties !== undefined && next.additionalProperties !== undefined)
    changes.push(
      ...breakingChanges(old.additionalProperties, next.additionalProperties, `${path}.*`),
    );
  if (old.items !== undefined || next.items !== undefined)
    changes.push(...breakingChanges(old.items, next.items, `${path}[]`));
  for (const union of ["anyOf", "oneOf"]) {
    const options = list(next[union]);
    for (const [index, option] of list(old[union]).entries())
      changes.push(
        ...(index < options.length
          ? breakingChanges(option, options[index], `${path}|${index}`)
          : [`${path}: ${union} option ${index} removed`]),
      );
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
    Object.hasOwn(next, name) ? breakingChanges(old[name], next[name], name) : [`${name}: removed`],
  );
}
