import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ExecuteToolOptions,
  McpToolConfigJsonSchema,
  McpToolConfigZod,
  RegisteredTool,
  ToolExecuteCallbackOptions,
} from "../types";

// Compile-time assertions. One-argument handlers must remain assignable after
// the handler signature gains a second (ctx) parameter, and the new consumer
// API types must accept both the Chrome ≤153 (string) and 154+ (object)
// inputSchema shapes.

const oneArgJson: McpToolConfigJsonSchema = {
  name: "one_arg",
  description: "legacy single-arg handler",
  handler: async (args) => ({
    content: [{ type: "text", text: String(Object.keys(args).length) }],
  }),
};

const twoArgJson: McpToolConfigJsonSchema = {
  name: "two_arg",
  description: "signal-aware handler",
  handler: async (_args, ctx: ToolExecuteCallbackOptions) => {
    ctx.signal.throwIfAborted();
    return { content: [{ type: "text", text: "ok" }] };
  },
};

const oneArgZod: McpToolConfigZod<{ q: z.ZodString }> = {
  name: "zod_one",
  description: "legacy single-arg zod handler",
  input: z.object({ q: z.string() }),
  handler: async ({ q }) => ({ content: [{ type: "text", text: q }] }),
};

const twoArgZod: McpToolConfigZod<{ q: z.ZodString }> = {
  name: "zod_two",
  description: "signal-aware zod handler",
  input: z.object({ q: z.string() }),
  handler: async ({ q }, { signal }) => {
    signal.throwIfAborted();
    return { content: [{ type: "text", text: q }] };
  },
};

const objectSchema: RegisteredTool = {
  name: "t1",
  description: "d",
  inputSchema: { type: "object", properties: {} },
};

const stringSchema: RegisteredTool = {
  name: "t2",
  description: "d",
  inputSchema: '{"type":"object"}',
};

const opts: ExecuteToolOptions = { signal: new AbortController().signal };

describe("type compatibility", () => {
  it("compiles", () => {
    expect([
      oneArgJson,
      twoArgJson,
      oneArgZod,
      twoArgZod,
      objectSchema,
      stringSchema,
      opts,
    ]).toHaveLength(7);
  });
});
