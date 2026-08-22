import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, ToolDescriptor, ToolExecuteCallbackOptions } from "../../types";
import { runTool } from "../execute";

function makeTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: "engine_tool",
    description: "engine test tool",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

const OK: CallToolResult = { content: [{ type: "text", text: "ok" }] };

describe("runTool", () => {
  it("passes parsed args and a fresh non-aborted signal to execute", async () => {
    const execute = vi.fn(
      async (_input: Record<string, unknown>, options: { signal: AbortSignal }) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal.aborted).toBe(false);
        return OK;
      },
    );
    await runTool(makeTool({ execute }), '{"query":"hi"}');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ query: "hi" });
  });

  it("accepts an object input without re-parsing", async () => {
    const execute = vi.fn(
      async (_input: Record<string, unknown>, _options: ToolExecuteCallbackOptions) => OK,
    );
    await runTool(makeTool({ execute }), { query: "hi" });
    expect(execute.mock.calls[0][0]).toEqual({ query: "hi" });
  });

  it("gives each execution an independent signal", async () => {
    const signals: AbortSignal[] = [];
    const tool = makeTool({
      inputSchema: undefined,
      execute: async (_i, { signal }) => {
        signals.push(signal);
        return OK;
      },
    });
    await runTool(tool, "{}");
    await runTool(tool, "{}");
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("serializes object results to JSON", async () => {
    const raw = await runTool(makeTool(), '{"query":"x"}');
    expect(JSON.parse(raw)).toEqual(OK);
  });

  it("stringifies primitive results and maps empty string to 'Operation succeeded'", async () => {
    // Non-CallToolResult returns exercise native-parity serialization.
    const num = makeTool({
      inputSchema: undefined,
      execute: () => 42 as unknown as CallToolResult,
    });
    expect(await runTool(num, "{}")).toBe("42");
    const empty = makeTool({
      inputSchema: undefined,
      execute: () => "" as unknown as CallToolResult,
    });
    expect(await runTool(empty, "{}")).toBe("Operation succeeded");
  });

  it("rejects UnknownError for a non-serializable (circular) result", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const tool = makeTool({
      inputSchema: undefined,
      execute: () => circular as unknown as CallToolResult,
    });
    await expect(runTool(tool, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects UnknownError on invalid JSON string input", async () => {
    await expect(runTool(makeTool(), "not json")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects UnknownError on non-object JSON input", async () => {
    await expect(runTool(makeTool(), '"a string"')).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects OperationError on schema violation (polyfill-only validation)", async () => {
    await expect(runTool(makeTool(), "{}")).rejects.toThrow(
      expect.objectContaining({
        name: "OperationError",
        message: 'Missing required field: "query"',
      }),
    );
  });

  it("rejects with the exact reason for a pre-aborted caller signal", async () => {
    const reason = new DOMException("pre-cancelled", "AbortError");
    await expect(runTool(makeTool(), '{"query":"x"}', AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
  });

  it("mid-flight abort: caller gets caller's reason, tool gets a generic AbortError", async () => {
    const controller = new AbortController();
    let toolReason: unknown;
    const tool = makeTool({
      inputSchema: undefined,
      execute: (_i, { signal }) =>
        new Promise<CallToolResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              toolReason = signal.reason;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const callerReason = new Error("custom cancellation reason");
    const promise = runTool(tool, "{}", controller.signal);
    controller.abort(callerReason);
    await expect(promise).rejects.toBe(callerReason);
    // Chrome 153: the tool-side signal always aborts with a generic AbortError,
    // never the caller's custom reason.
    expect((toolReason as { name?: string })?.name).toBe("AbortError");
    expect(toolReason).not.toBe(callerReason);
  });

  it("ignores late settlement after abort (no unhandled rejection, result stays rejected)", async () => {
    const controller = new AbortController();
    let resolveTool!: (r: CallToolResult) => void;
    const tool = makeTool({
      inputSchema: undefined,
      execute: () =>
        new Promise<CallToolResult>((resolve) => {
          resolveTool = resolve;
        }),
    });
    const promise = runTool(tool, "{}", controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    resolveTool(OK); // late — must be silently ignored
    await new Promise((r) => setTimeout(r, 0));
  });

  it("swallows late rejection after abort (no unhandled rejection)", async () => {
    const controller = new AbortController();
    let rejectTool!: (e: unknown) => void;
    const tool = makeTool({
      inputSchema: undefined,
      execute: () =>
        new Promise<CallToolResult>((_resolve, reject) => {
          rejectTool = reject;
        }),
    });
    const promise = runTool(tool, "{}", controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    rejectTool(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));
  });

  it("rejects UnknownError (message preserved) when the tool fails without abort", async () => {
    const tool = makeTool({
      inputSchema: undefined,
      execute: () => {
        throw new Error("handler broke");
      },
    });
    await expect(runTool(tool, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
    await expect(runTool(tool, "{}")).rejects.toThrow("handler broke");
  });
});
