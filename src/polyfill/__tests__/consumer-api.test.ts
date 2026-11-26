import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CallToolResult,
  ExecuteToolOptions,
  InputSchema,
  InputSchemaProperty,
  ModelContext,
  RegisteredTool,
  ToolDescriptor,
} from "../../types";
import { cleanupPolyfill, installPolyfill } from "..";

function makeTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: "consumer_tool",
    description: "consumer test tool",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

// The polyfill always implements getTools/executeTool; narrow once here.
type InstalledModelContext = ModelContext &
  Required<Pick<ModelContext, "getTools" | "executeTool">>;

// The schema shape makeTool() registers, down to the nested "query" property.
type SchemaWithQuery = InputSchema & { properties: { query: InputSchemaProperty } };

function mc(): InstalledModelContext {
  const m = document.modelContext;
  if (!m) throw new Error("polyfill not installed");
  return m as InstalledModelContext;
}

afterEach(() => {
  cleanupPolyfill();
});

describe("document.modelContext.getTools (polyfill)", () => {
  it("returns registered tools sorted by name with object inputSchema and defaults", async () => {
    installPolyfill();
    await mc().registerTool(makeTool({ name: "b_tool" }));
    await mc().registerTool(makeTool({ name: "a_tool" }));
    const tools = await mc().getTools();
    expect(tools.map((t) => t.name)).toEqual(["a_tool", "b_tool"]);
    expect(typeof tools[0].inputSchema).toBe("object");
    expect(tools[0].title).toBe("");
    expect(tools[0].description).toBe("consumer test tool");
    expect(tools[0].origin).toBe(location.origin);
    expect(tools[0].source).toBe(window);
    expect(tools[0].window).toBe(window);
  });

  it("returns a deep copy of inputSchema (mutation does not leak back)", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [first] = await mc().getTools();
    const firstSchema = first.inputSchema as SchemaWithQuery;
    // Mutate a nested node; a top-level mutation can't tell deep from shallow.
    firstSchema.type = "mutated";
    firstSchema.properties.query.type = "mutated";
    const [second] = await mc().getTools();
    const secondSchema = second.inputSchema as SchemaWithQuery;
    expect(secondSchema.type).toBe("object");
    expect(secondSchema.properties.query.type).toBe("string");
  });

  it("returns a deep copy of outputSchema and omits it when not registered", async () => {
    installPolyfill();
    const outputSchema: InputSchema = {
      type: "object",
      properties: { temperature: { type: "number" } },
      required: ["temperature"],
    };
    await mc().registerTool(makeTool({ name: "with_output", outputSchema }));
    await mc().registerTool(makeTool({ name: "without_output" }));
    const [withOutput, withoutOutput] = await mc().getTools();
    expect(withOutput.outputSchema).toEqual(outputSchema);
    expect(withOutput.outputSchema).not.toBe(outputSchema);
    expect(withoutOutput).not.toHaveProperty("outputSchema");

    (withOutput.outputSchema as InputSchema).type = "mutated";
    const [again] = await mc().getTools();
    expect(again.outputSchema?.type).toBe("object");
  });

  it("returns fresh objects on every call", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [a] = await mc().getTools();
    const [b] = await mc().getTools();
    expect(a).not.toBe(b);
  });

  it("preserves title and annotations when registered", async () => {
    installPolyfill();
    await mc().registerTool(makeTool({ title: "Nice Tool", annotations: { readOnlyHint: true } }));
    const [tool] = await mc().getTools();
    expect(tool.title).toBe("Nice Tool");
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it("passes consequentialHint and debugging through to getTools()", async () => {
    installPolyfill();
    await mc().registerTool(
      makeTool({ annotations: { consequentialHint: true, debugging: true } }),
    );
    const [tool] = await mc().getTools();
    expect(tool.annotations).toEqual({ consequentialHint: true, debugging: true });
  });

  it("rejects SecurityError for an untrustworthy fromOrigins entry", async () => {
    installPolyfill();
    await expect(mc().getTools({ fromOrigins: ["http://evil.example"] })).rejects.toThrow(
      expect.objectContaining({ name: "SecurityError" }),
    );
  });
});

describe("document.modelContext.executeTool (polyfill)", () => {
  it("executes by RegisteredTool and resolves the JSON result", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [tool] = await mc().getTools();
    const raw = await mc().executeTool(tool, '{"query":"x"}');
    expect(JSON.parse(raw as string)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("accepts an object inputArguments", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [tool] = await mc().getTools();
    const raw = await mc().executeTool(tool, { query: "x" });
    expect(JSON.parse(raw as string)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it.each([
    null,
    42,
    true,
    Symbol("input"),
  ])("rejects non-object input %s with UnknownError", async (input) => {
    installPolyfill();
    const execute = vi.fn(async () => ({ content: [] }));
    await mc().registerTool(makeTool({ inputSchema: undefined, execute }));
    const [tool] = await mc().getTools();
    const pending = mc().executeTool(tool, input as object);
    await expect(pending).rejects.toMatchObject({ name: "UnknownError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each<[string, [input?: object, options?: ExecuteToolOptions]]>([
    ["omitted input", []],
    ["undefined input", [undefined]],
    ["undefined input and options", [undefined, undefined]],
  ])("defaults %s to a fresh empty object", async (_label, args) => {
    installPolyfill();
    const execute = vi.fn(async (_input: Record<string, unknown>) => ({ content: [] }));
    await mc().registerTool(makeTool({ inputSchema: undefined, execute }));
    const [tool] = await mc().getTools();
    await expect(mc().executeTool(tool, ...args)).resolves.toBe('{"content":[]}');
    await expect(mc().executeTool(tool, ...args)).resolves.toBe('{"content":[]}');
    expect(execute).toHaveBeenCalledTimes(2);
    const [first, second] = execute.mock.calls;
    expect(first[0]).toEqual({});
    expect(second[0]).toEqual({});
    expect(first[0]).not.toBe(second[0]);
  });

  it.each<[string, ExecuteToolOptions]>([
    ["empty options", {}],
    ["undefined signal", { signal: undefined }],
    ["execution signal", { signal: new AbortController().signal }],
    ["null options", null as unknown as ExecuteToolOptions],
  ])("rejects undefined input with %s", async (_label, options) => {
    installPolyfill();
    const execute = vi.fn(async () => ({ content: [] }));
    await mc().registerTool(makeTool({ inputSchema: undefined, execute }));
    const [tool] = await mc().getTools();
    await expect(mc().executeTool(tool, undefined, options)).rejects.toMatchObject({
      name: "UnknownError",
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(mc().executeTool(tool, {}, options)).resolves.toBe('{"content":[]}');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("validates defaulted input against the tool schema", async () => {
    installPolyfill();
    const execute = vi.fn(async () => ({ content: [] }));
    await mc().registerTool(makeTool({ execute }));
    const [tool] = await mc().getTools();
    await expect(mc().executeTool(tool)).rejects.toMatchObject({ name: "OperationError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects UnknownError for a stale/unregistered tool", async () => {
    installPolyfill();
    const stale: RegisteredTool = { name: "ghost", description: "gone" };
    await expect(mc().executeTool(stale, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects a tool from getTools() once its registration is replaced (Chrome 160 parity)", async () => {
    installPolyfill();
    const first = new AbortController();
    const firstExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "first" }],
    }));
    await mc().registerTool(makeTool({ inputSchema: undefined, execute: firstExecute }), {
      signal: first.signal,
    });
    const [stale] = await mc().getTools();

    first.abort();
    const secondExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "second" }],
    }));
    await mc().registerTool(makeTool({ inputSchema: undefined, execute: secondExecute }));

    await expect(mc().executeTool(stale, {})).rejects.toMatchObject({ name: "UnknownError" });
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).not.toHaveBeenCalled();

    const [fresh] = await mc().getTools();
    await expect(mc().executeTool(fresh, {})).resolves.toContain("second");
    expect(secondExecute).toHaveBeenCalledTimes(1);
  });

  it("binds a tool from getTools() to its registration even if its name is changed", async () => {
    installPolyfill();
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "a" }] }));
    const otherExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "b" }] }));
    await mc().registerTool(makeTool({ name: "a_tool", inputSchema: undefined, execute }));
    await mc().registerTool(
      makeTool({ name: "b_tool", inputSchema: undefined, execute: otherExecute }),
    );
    const [aTool] = await mc().getTools();
    aTool.name = "b_tool";

    await mc().executeTool(aTool, {});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(otherExecute).not.toHaveBeenCalled();
  });

  it("still runs a plain object naming a registered tool (1.x compatibility)", async () => {
    installPolyfill();
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    await mc().registerTool(makeTool({ inputSchema: undefined, execute }));
    const plain: RegisteredTool = { name: "consumer_tool", description: "consumer test tool" };
    await mc().executeTool(plain, {});
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("forwards the caller signal: tool-side signal aborts, caller gets its reason", async () => {
    installPolyfill();
    let toolAborted = false;
    await mc().registerTool(
      makeTool({
        inputSchema: undefined,
        execute: (_input, { signal }) =>
          new Promise<CallToolResult>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                toolAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
    );
    const [tool] = await mc().getTools();
    const controller = new AbortController();
    const reason = new Error("cancel it");
    const promise = mc().executeTool(tool, "{}", { signal: controller.signal });
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(toolAborted).toBe(true);
  });

  it("keeps an in-flight execution alive when the tool is unregistered mid-flight", async () => {
    installPolyfill();
    const registration = new AbortController();
    let resolveTool!: (r: CallToolResult) => void;
    let toolSignalAborted = false;
    let started = false;
    await mc().registerTool(
      makeTool({
        inputSchema: undefined,
        execute: (_input, { signal }) => {
          started = true;
          signal.addEventListener("abort", () => {
            toolSignalAborted = true;
          });
          return new Promise<CallToolResult>((resolve) => {
            resolveTool = resolve;
          });
        },
      }),
      { signal: registration.signal },
    );
    const [tool] = await mc().getTools();
    const pending = mc().executeTool(tool, "{}");
    await Promise.resolve(); // flush the microtask that starts execute
    expect(started).toBe(true);
    registration.abort(); // unregister mid-flight (Chrome 153.0.8008+ behavior)
    resolveTool({ content: [{ type: "text", text: "late-ok" }] });
    const raw = await pending;
    expect(JSON.parse(raw as string).content[0].text).toBe("late-ok");
    expect(toolSignalAborted).toBe(false);
    expect((await mc().getTools()).map((t) => t.name)).not.toContain("consumer_tool");
  });
});

describe("document.modelContext.waitForToolsUntil (polyfill)", () => {
  function waitForToolsUntil(): (promise: Promise<unknown>) => void {
    const fn = mc().waitForToolsUntil;
    if (!fn) throw new Error("waitForToolsUntil missing");
    return fn;
  }

  it("accepts a promise and returns undefined", async () => {
    installPolyfill();
    expect(waitForToolsUntil().call(mc(), Promise.resolve())).toBeUndefined();
  });

  it("handles a rejected promise so it is not reported as unhandled", async () => {
    installPolyfill();
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      waitForToolsUntil().call(mc(), Promise.reject(new Error("registration failed")));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("throws TypeError when called without a promise", () => {
    installPolyfill();
    expect(() => Reflect.apply(waitForToolsUntil(), mc(), [])).toThrow(TypeError);
  });
});
