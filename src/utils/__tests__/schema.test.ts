import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { InputSchema } from "../../types";
import { schemaFingerprint, zodToInputSchema } from "../schema";

// ─── zodToInputSchema ────────────────────────────────────────────

describe("zodToInputSchema", () => {
  it("converts a simple object with required fields", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToInputSchema(schema);

    expect(result.type).toBe("object");
    expect(result.properties).toEqual({
      name: { type: "string" },
      age: { type: "number" },
    });
    expect(result.required).toEqual(["name", "age"]);
    expect(result.additionalProperties).toBe(false);
  });

  it("excludes optional fields from required", () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });
    const result = zodToInputSchema(schema);

    expect(result.required).toEqual(["name"]);
    expect(result.properties).toHaveProperty("nickname");
  });

  it("excludes fields with defaults from required and includes default value", () => {
    const schema = z.object({
      name: z.string(),
      role: z.string().default("user"),
    });
    const result = zodToInputSchema(schema);

    expect(result.required).toEqual(["name"]);
    expect(result.properties?.role).toMatchObject({
      type: "string",
      default: "user",
    });
  });

  it("keeps nullable fields in required with array type", () => {
    const schema = z.object({
      name: z.string(),
      deletedAt: z.string().nullable(),
    });
    const result = zodToInputSchema(schema);

    expect(result.required).toEqual(["name", "deletedAt"]);
    expect(result.properties?.deletedAt).toMatchObject({
      type: ["string", "null"],
    });
  });

  it("handles nested objects", () => {
    const schema = z.object({
      address: z.object({ street: z.string(), zip: z.string() }),
    });
    const result = zodToInputSchema(schema);

    expect(result.properties?.address).toMatchObject({
      type: "object",
      properties: {
        street: { type: "string" },
        zip: { type: "string" },
      },
      required: ["street", "zip"],
      additionalProperties: false,
    });
  });

  it("handles arrays", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = zodToInputSchema(schema);

    expect(result.properties?.tags).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  it("handles enums", () => {
    const schema = z.object({ status: z.enum(["active", "inactive"]) });
    const result = zodToInputSchema(schema);

    expect(result.properties?.status).toMatchObject({
      type: "string",
      enum: ["active", "inactive"],
    });
  });

  it("preserves descriptions from z.describe()", () => {
    const schema = z.object({
      name: z.string().describe("The user's name"),
    });
    const result = zodToInputSchema(schema);

    expect(result.properties?.name).toMatchObject({
      type: "string",
      description: "The user's name",
    });
  });

  it("strips $schema metadata key", () => {
    const schema = z.object({ x: z.string() });
    const result = zodToInputSchema(schema);

    expect(result).not.toHaveProperty("$schema");
  });

  it("handles an empty object schema", () => {
    const schema = z.object({});
    const result = zodToInputSchema(schema);

    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
    expect(result.additionalProperties).toBe(false);
  });

  it("handles boolean properties", () => {
    const schema = z.object({ active: z.boolean() });
    const result = zodToInputSchema(schema);

    expect(result.properties?.active).toMatchObject({ type: "boolean" });
    expect(result.required).toEqual(["active"]);
  });

  it("inlines shared sub-schemas instead of emitting $ref", () => {
    const address = z.object({ street: z.string(), zip: z.string() });
    const schema = z.object({ home: address, work: address });
    const result = zodToInputSchema(schema);

    // Both properties should have full inline schemas, no $ref
    expect(result.properties?.home).toHaveProperty("type", "object");
    expect(result.properties?.work).toHaveProperty("type", "object");
    expect(result.properties?.work).not.toHaveProperty("$ref");
  });
});

// ─── schemaFingerprint ───────────────────────────────────────────

describe("schemaFingerprint", () => {
  it("returns empty string for undefined", () => {
    expect(schemaFingerprint(undefined)).toBe("");
  });

  it("returns JSON.stringify for plain InputSchema", () => {
    const schema: InputSchema = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    expect(schemaFingerprint(schema)).toBe(JSON.stringify(schema));
  });

  it("converts Zod schema then stringifies", () => {
    const zodSchema = z.object({ x: z.string() });
    expect(schemaFingerprint(zodSchema)).toBe(JSON.stringify(zodToInputSchema(zodSchema)));
  });

  it("produces identical fingerprints for identical Zod schemas", () => {
    const a = z.object({ x: z.string(), y: z.number() });
    const b = z.object({ x: z.string(), y: z.number() });
    expect(a).not.toBe(b); // different references
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
  });

  it("produces different fingerprints for different schemas", () => {
    const a = z.object({ x: z.string() });
    const b = z.object({ y: z.number() });
    expect(schemaFingerprint(a)).not.toBe(schemaFingerprint(b));
  });

  it("does not throw on a circular (non-serializable) schema", () => {
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;
    expect(() => schemaFingerprint(circular as never)).not.toThrow();
  });
});
