import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult, ModelContext, RegisteredTool, ToolDescriptor } from "../../types";
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
    expect(tools[0].window).toBe(window);
  });

  it("returns a deep copy of inputSchema (mutation does not leak back)", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [first] = await mc().getTools();
    (first.inputSchema as Record<string, unknown>).type = "mutated";
    const [second] = await mc().getTools();
    expect((second.inputSchema as Record<string, unknown>).type).toBe("object");
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

  it("rejects UnknownError for a stale/unregistered tool", async () => {
    installPolyfill();
    const stale: RegisteredTool = { name: "ghost", description: "gone" };
    await expect(mc().executeTool(stale, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
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
    await mc().registerTool(
      makeTool({
        inputSchema: undefined,
        execute: (_input, { signal }) => {
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
    await Promise.resolve(); // let execute start
    registration.abort(); // unregister mid-flight (Chrome 153.0.8008+ behavior)
    resolveTool({ content: [{ type: "text", text: "late-ok" }] });
    const raw = await pending;
    expect(JSON.parse(raw as string).content[0].text).toBe("late-ok");
    expect(toolSignalAborted).toBe(false);
    expect((await mc().getTools()).map((t) => t.name)).not.toContain("consumer_tool");
  });
});
