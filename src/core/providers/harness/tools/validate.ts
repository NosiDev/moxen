/**
 * Check a call's arguments against the tool's JSON Schema, fixing the slips
 * small models make most (a number or boolean sent as a string) instead of
 * bouncing them back. Only the subset of JSON Schema our own tools use is
 * understood; MCP tools bring their own schemas and are validated by their
 * servers.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
};

export type ValidationResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function coerce(value: unknown, schema: Schema): unknown {
  if (typeof value !== "string") return value;
  if (schema.type === "number" || schema.type === "integer") {
    const trimmed = value.trim();
    return trimmed !== "" && Number.isFinite(Number(trimmed)) ? Number(trimmed) : value;
  }
  if (schema.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

function matches(value: unknown, schema: Schema): boolean {
  switch (schema.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value) && (schema.items === undefined || value.every((entry) => matches(entry, schema.items!)));
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

export function validateToolArguments(rawArguments: string, schema: Record<string, unknown>, toolName: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch (error) {
    return { ok: false, error: `The arguments for ${toolName} are not valid JSON (${(error as Error).message}). Send a single JSON object.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `The arguments for ${toolName} must be a JSON object.` };
  }
  const root = schema as Schema;
  const input = parsed as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const property = root.properties?.[key];
    args[key] = property ? coerce(value, property) : value;
  }
  for (const key of root.required ?? []) {
    if (args[key] === undefined || args[key] === null) return { ok: false, error: `${toolName} needs the "${key}" argument.` };
  }
  for (const [key, property] of Object.entries(root.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) {
      delete args[key];
      continue;
    }
    if (!matches(value, property)) {
      return { ok: false, error: `The "${key}" argument of ${toolName} must be ${property.type === "integer" ? "a whole number" : `of type ${property.type}`}.` };
    }
    if (property.enum && !property.enum.includes(value)) {
      return { ok: false, error: `The "${key}" argument of ${toolName} must be one of: ${property.enum.map(String).join(", ")}.` };
    }
  }
  return { ok: true, args };
}
