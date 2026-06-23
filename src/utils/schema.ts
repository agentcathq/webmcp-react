import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { InputSchema } from "../types";

// Strips the `$schema` key since MCP doesn't use it.
export function zodToInputSchema(zodObject: z.ZodObject<z.ZodRawShape>): InputSchema {
  const jsonSchema = zodToJsonSchema(zodObject, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete jsonSchema.$schema;
  return jsonSchema as InputSchema;
}

// Stable string for useEffect deps — same structure = same fingerprint regardless of reference.
export function schemaFingerprint(
  schema: InputSchema | z.ZodObject<z.ZodRawShape> | undefined,
): string {
  if (schema === undefined) return "";
  if (schema instanceof z.ZodObject) {
    return JSON.stringify(zodToInputSchema(schema));
  }
  try {
    return JSON.stringify(schema);
  } catch {
    return "__unserializable__";
  }
}
