import type { InputSchema } from "../types";

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME_RE.test(name);
}

export function isPotentiallyTrustworthyOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // file: is an intentional allowance; file: URLs have a null origin so check it first.
  if (url.protocol === "file:") {
    return true;
  }
  // Must be a bare origin — reject inputs carrying a path, query, or credentials.
  if (url.origin !== origin) {
    return false;
  }
  if (url.protocol === "https:" || url.protocol === "wss:") {
    return true;
  }
  const host = url.hostname;
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1"
  );
}

const TYPE_CHECKERS: Record<string, (val: unknown) => boolean> = {
  string: (val) => typeof val === "string",
  number: (val) => typeof val === "number" && !Number.isNaN(val),
  integer: (val) => typeof val === "number" && Number.isInteger(val),
  boolean: (val) => typeof val === "boolean",
  object: (val) => typeof val === "object" && val !== null && !Array.isArray(val),
  array: (val) => Array.isArray(val),
  null: (val) => val === null,
};

export function validateArgs(args: Record<string, unknown>, schema: InputSchema): void {
  if (schema.required) {
    for (const key of schema.required) {
      if (args[key] === undefined) {
        throw new DOMException(`Missing required field: "${key}"`, "OperationError");
      }
    }
  }

  if (schema.properties) {
    for (const key of Object.keys(args)) {
      const prop = schema.properties[key];
      if (!prop?.type) continue;

      const checker = TYPE_CHECKERS[prop.type];
      if (!checker) continue;

      if (!checker(args[key])) {
        throw new DOMException(
          `Invalid type for field "${key}": expected ${prop.type}`,
          "OperationError",
        );
      }
    }
  }
}
