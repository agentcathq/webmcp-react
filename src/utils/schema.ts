import * as z3 from "zod/v3";
import * as z4 from "zod/v4/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { InputSchema, ZodInput, ZodObjectSchema } from "../types";

export function isZodObjectSchema(schema: unknown): schema is ZodObjectSchema {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }

  if ("_zod" in schema) {
    return (schema as z4.$ZodType)._zod.def.type === "object";
  }

  return (
    "_def" in schema &&
    (schema as z3.ZodTypeAny)._def.typeName === z3.ZodFirstPartyTypeKind.ZodObject
  );
}

export function parseZodInput<T extends ZodObjectSchema>(schema: T, input: unknown): ZodInput<T> {
  if ("_zod" in schema) {
    return z4.parse(schema, input) as ZodInput<T>;
  }

  return schema.parse(input) as ZodInput<T>;
}

// Strips the `$schema` key since MCP doesn't use it.
export function zodToInputSchema(zodObject: ZodObjectSchema): InputSchema {
  const jsonSchema = (
    "_zod" in zodObject
      ? z4.toJSONSchema(zodObject, { io: "input", target: "draft-07" })
      : zodToJsonSchema(zodObject, { $refStrategy: "none" })
  ) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema as InputSchema;
}

// Stable string for useEffect deps — same structure = same fingerprint regardless of reference.
export function schemaFingerprint(schema: InputSchema | ZodObjectSchema | undefined): string {
  if (schema === undefined) return "";
  if (isZodObjectSchema(schema)) {
    return JSON.stringify(zodToInputSchema(schema));
  }
  try {
    return JSON.stringify(schema);
  } catch {
    return "__unserializable__";
  }
}
