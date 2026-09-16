import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, ToolDescriptor } from "../../types";
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

  it("accepts an object input", async () => {
    const execute = vi.fn(async () => OK);
    await runTool(makeTool({ execute }), { query: "hi" });
    expect(execute.mock.calls[0][0]).toEqual({ query: "hi" });
  });

  it("gives the tool an independent JSON copy of nested input", async () => {
    const input = { nested: { value: "original" } };
    const tool = makeTool({
      inputSchema: undefined,
      execute: (args) => {
        (args.nested as { value: string }).value = "changed";
        return OK;
      },
    });
    await runTool(tool, input);
    expect(input.nested.value).toBe("original");
  });

  it("applies JSON transformations before validating the input schema", async () => {
    const execute = vi.fn(async () => OK);
    await runTool(makeTool({ execute }), {
      query: { toJSON: () => "hi" },
      nested: { omitted: undefined, values: [undefined, Number.NaN] },
    });
    expect(execute).toHaveBeenCalledWith(
      { query: "hi", nested: { values: [null, null] } },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["array", [1, 2], [1, 2]],
    ["custom toJSON", { toJSON: () => ({ query: "hi" }) }, { query: "hi" }],
    [
      "callable object",
      Object.assign(() => {}, { toJSON: () => ({ query: "hi" }) }),
      { query: "hi" },
    ],
  ])("accepts a serializable %s", async (_label, input, expected) => {
    const execute = vi.fn(async () => OK);
    await runTool(makeTool({ inputSchema: undefined, execute }), input as object);
    expect(execute.mock.calls[0][0]).toEqual(expected);
  });

  it.each([
    [
      "cycle",
      () => {
        const input: Record<string, unknown> = {};
        input.self = input;
        return input;
      },
    ],
    ["BigInt", () => ({ value: 1n })],
    ["undefined serialization", () => ({ toJSON: () => undefined })],
    ["function", () => () => {}],
  ])("rejects %s input without executing the tool", async (_label, makeInput) => {
    const execute = vi.fn(async () => OK);
    const pending = runTool(makeTool({ inputSchema: undefined, execute }), makeInput());
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["getter", "toJSON"])("preserves an exception thrown by an input %s", async (kind) => {
    const reason = new Error("cannot read input");
    const fail = () => {
      throw reason;
    };
    const input =
      kind === "toJSON"
        ? { toJSON: fail }
        : Object.defineProperty({}, "query", { get: fail, enumerable: true });
    const execute = vi.fn(async () => OK);
    const pending = runTool(makeTool({ execute }), input);
    await expect(pending).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an object that serializes to a primitive before executing the tool", async () => {
    const execute = vi.fn(async () => OK);
    await expect(
      runTool(makeTool({ inputSchema: undefined, execute }), { toJSON: () => 42 }),
    ).rejects.toThrow(expect.objectContaining({ name: "UnknownError" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute if input serialization aborts the caller signal", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled while reading input");
    const execute = vi.fn(async () => OK);
    const input = {
      toJSON() {
        controller.abort(reason);
        return { query: "hi" };
      },
    };
    await expect(runTool(makeTool({ execute }), input, controller.signal)).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
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

  it.each([
    "not json",
    "null",
  ])("preserves the abort reason for pre-aborted legacy input %s", async (input) => {
    const reason = new Error("cancelled");
    await expect(runTool(makeTool(), input, AbortSignal.abort(reason))).rejects.toBe(reason);
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
