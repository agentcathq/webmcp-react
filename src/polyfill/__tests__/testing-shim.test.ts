import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, ToolDescriptor, ToolExecuteCallbackOptions } from "../../types";
import { _resetWarnings } from "../../utils/warn";
import { createRegistry } from "../registry";
import { createTestingShim } from "../testing-shim";

function makeTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"] as const,
    },
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    ...overrides,
  };
}

function makeResult(text = "ok"): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function setup(tools: ToolDescriptor[] = [makeTool()]) {
  const registry = createRegistry();
  for (const tool of tools) {
    registry.registerTool(tool);
  }
  const shim = createTestingShim(registry);
  return { registry, shim };
}

describe("createTestingShim", () => {
  describe("listTools", () => {
    it("returns tools with stringified inputSchema", () => {
      const { shim } = setup();
      const tools = shim.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("test_tool");
      expect(tools[0].description).toBe("A test tool");
      expect(typeof tools[0].inputSchema).toBe("string");
      expect(JSON.parse(tools[0].inputSchema as string)).toEqual({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      });
    });

    it("returns empty array when no tools", () => {
      const { shim } = setup([]);
      expect(shim.listTools()).toEqual([]);
    });
  });

  describe("executeTool", () => {
    it("calls handler with parsed args", async () => {
      const handler = vi.fn(
        async (_input: Record<string, unknown>, _options: ToolExecuteCallbackOptions) =>
          makeResult(),
      );
      const { shim } = setup([makeTool({ execute: handler })]);

      await shim.executeTool("test_tool", '{"query":"hello"}');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({ query: "hello" });
    });

    it("calls execute with input and an options object carrying an AbortSignal", async () => {
      // Chrome 153+ shape: execute(input, { signal }).
      const registry = createRegistry();
      const shim = createTestingShim(registry);
      let args: unknown[] = [];
      await registry.registerTool({
        name: "arity_tool",
        description: "checks arity",
        execute: (...a: unknown[]) => {
          args = a;
          return { content: [{ type: "text", text: "ok" }] };
        },
      });
      await shim.executeTool("arity_tool", "{}");
      expect(args).toHaveLength(2);
      expect((args[1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });

    it("returns stringified CallToolResult", async () => {
      const { shim } = setup();
      const result = await shim.executeTool("test_tool", '{"query":"hi"}');
      expect(result).toBe(JSON.stringify(makeResult()));
    });

    it("throws NotFoundError for unknown tool", async () => {
      const { shim } = setup();
      await expect(shim.executeTool("nope", "{}")).rejects.toThrow(
        expect.objectContaining({ name: "NotFoundError" }),
      );
    });

    it("throws OperationError on invalid JSON", async () => {
      const { shim } = setup();
      await expect(shim.executeTool("test_tool", "not json")).rejects.toThrow(
        expect.objectContaining({ name: "OperationError", message: "Invalid JSON input" }),
      );
    });

    it("throws OperationError on non-object JSON (string)", async () => {
      const { shim } = setup();
      await expect(shim.executeTool("test_tool", '"a string"')).rejects.toThrow(
        expect.objectContaining({ name: "OperationError", message: "Input must be a JSON object" }),
      );
    });

    it("throws OperationError on non-object JSON (array)", async () => {
      const { shim } = setup();
      await expect(shim.executeTool("test_tool", "[1,2]")).rejects.toThrow(
        expect.objectContaining({ name: "OperationError", message: "Input must be a JSON object" }),
      );
    });

    it("throws OperationError on non-object JSON (null)", async () => {
      const { shim } = setup();
      await expect(shim.executeTool("test_tool", "null")).rejects.toThrow(
        expect.objectContaining({ name: "OperationError", message: "Input must be a JSON object" }),
      );
    });

    it("validates args against schema", async () => {
      const { shim } = setup();
      await expect(shim.executeTool("test_tool", "{}")).rejects.toThrow(
        expect.objectContaining({
          name: "OperationError",
          message: 'Missing required field: "query"',
        }),
      );
    });

    it("handles async handlers", async () => {
      const { shim } = setup([
        makeTool({
          execute: () =>
            new Promise((resolve) => setTimeout(() => resolve(makeResult("async")), 10)),
        }),
      ]);
      const result = await shim.executeTool("test_tool", '{"query":"x"}');
      expect(JSON.parse(result as string)).toEqual(makeResult("async"));
    });

    it("propagates handler errors", async () => {
      const { shim } = setup([
        makeTool({
          execute: () => {
            throw new Error("handler broke");
          },
        }),
      ]);
      await expect(shim.executeTool("test_tool", '{"query":"x"}')).rejects.toThrow("handler broke");
    });

    it("rejects with AbortError when signal fires mid-execution", async () => {
      const controller = new AbortController();
      const { shim } = setup([
        makeTool({
          execute: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(makeResult()), 100);
            }),
        }),
      ]);

      const promise = shim.executeTool("test_tool", '{"query":"x"}', { signal: controller.signal });
      controller.abort();

      await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    });

    it("rejects with AbortError when handler synchronously aborts", async () => {
      const controller = new AbortController();
      const { shim } = setup([
        makeTool({
          execute: () => {
            controller.abort();
            return makeResult();
          },
        }),
      ]);

      await expect(
        shim.executeTool("test_tool", '{"query":"x"}', { signal: controller.signal }),
      ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    });

    it("rejects with the abort reason (not the handler error) when handler aborts then throws", async () => {
      // Chrome 152+: once aborted, the caller sees the abort reason; the
      // tool's late failure is discarded. No unhandled rejection either way.
      const controller = new AbortController();
      const { shim } = setup([
        makeTool({
          execute: () => {
            controller.abort();
            throw new Error("handler threw after aborting");
          },
        }),
      ]);

      await expect(
        shim.executeTool("test_tool", '{"query":"x"}', { signal: controller.signal }),
      ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    });

    it("rejects immediately with AbortError for pre-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const { shim } = setup();

      await expect(
        shim.executeTool("test_tool", '{"query":"x"}', { signal: controller.signal }),
      ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    });

    it("warns once about deprecation", async () => {
      _resetWarnings();
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { shim } = setup();
      await shim.executeTool("test_tool", '{"query":"x"}');
      shim.listTools();
      const deprecationWarns = spy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("modelContextTesting is deprecated"),
      );
      expect(deprecationWarns).toHaveLength(1);
      spy.mockRestore();
    });
  });

  describe("registerToolsChangedCallback", () => {
    it("receives change notifications", async () => {
      const registry = createRegistry();
      const shim = createTestingShim(registry);
      const cb = vi.fn();
      shim.registerToolsChangedCallback(cb);

      registry.registerTool(makeTool());
      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCrossDocumentScriptToolResult", () => {
    it('returns "[]"', async () => {
      const { shim } = setup();
      expect(await shim.getCrossDocumentScriptToolResult()).toBe("[]");
    });
  });
});
