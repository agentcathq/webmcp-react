import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as z3 from "zod/v3";
import { _resetPolyfillConsumerCount, WebMCPProvider } from "../../context";
import { cleanupPolyfill } from "../../polyfill";
import type {
  CallToolResult,
  McpToolConfigJsonSchema,
  McpToolConfigZod,
  ToolDescriptor,
} from "../../types";
import { _resetWarnings } from "../../utils/warn";
import { _resetToolOwners, useMcpTool } from "../useMcpTool";

// ─── Helpers ──────────────────────────────────────────────────────

const OK_RESULT: CallToolResult = {
  content: [{ type: "text", text: "ok" }],
};

function makeResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function renderWithProvider(ui: React.ReactElement) {
  return render(
    <WebMCPProvider name="test" version="1.0">
      {ui}
    </WebMCPProvider>,
  );
}

/** Wait for the provider to install the polyfill and tools to register. */
async function waitForRegistration() {
  await waitFor(() => {
    expect(navigator.modelContextTesting).toBeDefined();
  });
  // Let microtasks (tool change notifications) settle
  await act(async () => {});
}

type ExecuteFn = ReturnType<typeof useMcpTool>["execute"];
type ResetFn = ReturnType<typeof useMcpTool>["reset"];
type ToolConfig = McpToolConfigZod | McpToolConfigJsonSchema;

// ─── Test component ──────────────────────────────────────────────

function ToolComponent({
  config,
  onState,
  onExecuteRef,
  onResetRef,
}: {
  config: ToolConfig;
  onState?: (state: ReturnType<typeof useMcpTool>["state"]) => void;
  onExecuteRef?: React.MutableRefObject<ExecuteFn | null>;
  onResetRef?: React.MutableRefObject<ResetFn | null>;
}) {
  const { state, execute, reset } = useMcpTool(config as McpToolConfigJsonSchema);
  onState?.(state);
  if (onExecuteRef) onExecuteRef.current = execute;
  if (onResetRef) onResetRef.current = reset;
  return (
    <div>
      <span data-testid="executing">{state.isExecuting ? "yes" : "no"}</span>
      <span data-testid="error">{state.error?.message ?? "none"}</span>
      <span data-testid="count">{state.executionCount}</span>
      <span data-testid="result">
        {state.lastResult
          ? state.lastResult.content.map((c) => ("text" in c ? c.text : "")).join("")
          : "null"}
      </span>
    </div>
  );
}

// ─── Setup / teardown ─────────────────────────────────────────────

afterEach(() => {
  cleanup();
  cleanupPolyfill();
  _resetPolyfillConsumerCount();
  _resetWarnings();
  _resetToolOwners();
  vi.restoreAllMocks();
});

// ─── Registration lifecycle ──────────────────────────────────────

describe("registration lifecycle", () => {
  it("registers tool with Zod schema on mount", async () => {
    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          input: z.object({ name: z.string() }),
          handler: async () => OK_RESULT,
        }}
      />,
    );

    await waitForRegistration();

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");
    expect(tools[0].description).toBe("Say hello");

    const schema = JSON.parse(tools[0].inputSchema ?? "{}");
    expect(schema.type).toBe("object");
    expect(schema.properties.name.type).toBe("string");
    expect(schema.required).toContain("name");
  });

  it("registers and validates Zod 3 schemas on both execution paths", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          input: z3.object({ name: z3.string().min(3) }),
          handler: async ({ name }) => makeResult(`hello ${name}`),
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    const schema = JSON.parse(tools[0].inputSchema ?? "{}");
    expect(schema.properties.name.type).toBe("string");

    let directResult: CallToolResult | undefined;
    await act(async () => {
      directResult = await executeRef.current?.({ name: "world" });
    });
    expect(directResult?.content[0]).toMatchObject({ type: "text", text: "hello world" });

    let externalResultJson: string | null | undefined;
    await act(async () => {
      externalResultJson = await navigator.modelContextTesting?.executeTool(
        "greet",
        JSON.stringify({ name: "x" }),
      );
    });
    expect(JSON.parse(externalResultJson ?? "{}")).toMatchObject({ isError: true });
  });

  it("registers tool with JSON Schema on mount", async () => {
    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          handler: async () => OK_RESULT,
        }}
      />,
    );

    await waitForRegistration();

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");
  });

  it("registers with annotations and output schema", async () => {
    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            title: "Greeter",
            description: "Say hello",
            input: z.object({ name: z.string() }),
            output: z.object({ greeting: z.string() }),
            annotations: { readOnlyHint: true },
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    // listTools() only returns name/description/inputSchema, so spy on registerTool
    // and trigger re-registration by changing description.
    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            title: "Greeter",
            description: "Say hello v2",
            input: z.object({ name: z.string() }),
            output: z.object({ greeting: z.string() }),
            annotations: { readOnlyHint: true },
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    const descriptor = spy.mock.calls[spy.mock.calls.length - 1][0];
    expect(descriptor.title).toBe("Greeter");
    expect(descriptor.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(descriptor.outputSchema).toBeDefined();
    expect(descriptor.outputSchema?.properties?.greeting).toBeDefined();
  });

  it("forwards top-level title and narrowed annotations to the descriptor", async () => {
    function Tool({ description }: { description: string }) {
      useMcpTool({
        name: "greet",
        title: "Greeter",
        description,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        handler: () => ({ content: [{ type: "text", text: "hi" }] }),
      });
      return null;
    }
    const { rerender } = render(
      <WebMCPProvider name="t" version="1">
        <Tool description="greets" />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="t" version="1">
        <Tool description="greets v2" />
      </WebMCPProvider>,
    );

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const descriptor = spy.mock.calls[0][0];
    expect(descriptor.title).toBe("Greeter");
    expect(descriptor.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  });

  it("removes tool on unmount", async () => {
    const { unmount } = renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
          },
          handler: async () => OK_RESULT,
        }}
      />,
    );

    await waitForRegistration();
    expect(navigator.modelContextTesting?.listTools()).toHaveLength(1);

    unmount();

    await waitFor(() => expect(navigator.modelContextTesting?.listTools() ?? []).toHaveLength(0));
  });

  it("forwards exposedTo and re-registers when it changes", async () => {
    function Tool({ origins }: { origins: string[] }) {
      useMcpTool({
        name: "scoped",
        description: "scoped tool",
        exposedTo: origins,
        handler: () => ({ content: [{ type: "text", text: "hi" }] }),
      });
      return null;
    }
    const { rerender } = render(
      <WebMCPProvider name="t" version="1">
        <Tool origins={["https://a.example"]} />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext as NonNullable<typeof document.modelContext>;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc, "registerTool");

    rerender(
      <WebMCPProvider name="t" version="1">
        <Tool origins={["https://b.example"]} />
      </WebMCPProvider>,
    );

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.at(-1)?.[1]?.exposedTo).toEqual(["https://b.example"]);
  });

  it("re-registers when description changes", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;

    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => OK_RESULT,
          }}
          onExecuteRef={executeRef}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello v2",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => OK_RESULT,
          }}
          onExecuteRef={executeRef}
        />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe("Say hello v2");
  });

  it("re-registers when Zod input schema value changes", async () => {
    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            input: z.object({ name: z.string() }),
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            input: z.object({ name: z.string(), age: z.number() }),
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    const schema = JSON.parse(tools[0].inputSchema ?? "{}");
    expect(schema.properties.age).toBeDefined();
  });

  it("re-registers when JSON inputSchema value changes", async () => {
    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" }, age: { type: "number" } },
            },
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    const schema = JSON.parse(tools[0].inputSchema ?? "{}");
    expect(schema.properties.age).toBeDefined();
  });

  it("does NOT re-register when Zod schema reference changes but shape is identical", async () => {
    const schema1 = z.object({ name: z.string() });

    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            input: schema1,
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    const schema2 = z.object({ name: z.string() });
    expect(schema1).not.toBe(schema2);

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            input: schema2,
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await act(async () => {});

    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT re-register when JSON Schema reference changes but value is identical", async () => {
    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await act(async () => {});

    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT re-register when handler changes", async () => {
    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => makeResult("first"),
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const mc = document.modelContext;
    expect(mc).toBeDefined();
    const spy = vi.spyOn(mc as NonNullable<typeof mc>, "registerTool");

    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            handler: async () => makeResult("second"),
          }}
        />
      </WebMCPProvider>,
    );

    // Give any potential effect a chance to run
    await act(async () => {});

    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── Strict Mode safety ──────────────────────────────────────────

describe("Strict Mode safety", () => {
  it("one tool visible after Strict Mode double-mount", async () => {
    render(
      <StrictMode>
        <WebMCPProvider name="test" version="1.0">
          <ToolComponent
            config={{
              name: "greet",
              description: "Say hello",
              input: z.object({ name: z.string() }),
              handler: async () => OK_RESULT,
            }}
          />
        </WebMCPProvider>
      </StrictMode>,
    );

    await waitForRegistration();

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");
  });

  it("tool is callable via executeTool after Strict Mode double-mount", async () => {
    render(
      <StrictMode>
        <WebMCPProvider name="test" version="1.0">
          <ToolComponent
            config={{
              name: "greet",
              description: "Say hello",
              input: z.object({ name: z.string() }),
              handler: async ({ name }: Record<string, unknown>) => makeResult(`hello ${name}`),
            }}
          />
        </WebMCPProvider>
      </StrictMode>,
    );

    await waitForRegistration();

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool(
        "greet",
        JSON.stringify({ name: "world" }),
      );
    });

    const result = JSON.parse(resultJson ?? "null");
    expect(result.content[0].text).toBe("hello world");
  });

  it("tool removed on real unmount in Strict Mode", async () => {
    const { unmount } = render(
      <StrictMode>
        <WebMCPProvider name="test" version="1.0">
          <ToolComponent
            config={{
              name: "greet",
              description: "Say hello",
              input: z.object({ name: z.string() }),
              handler: async () => OK_RESULT,
            }}
          />
        </WebMCPProvider>
      </StrictMode>,
    );

    await waitForRegistration();
    expect(navigator.modelContextTesting?.listTools()).toHaveLength(1);

    unmount();

    await waitFor(() => expect(navigator.modelContextTesting?.listTools() ?? []).toHaveLength(0));
  });
});

// ─── Execution state ─────────────────────────────────────────────

describe("execution state", () => {
  it("returns correct initial state", async () => {
    const states: ReturnType<typeof useMcpTool>["state"][] = [];

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => OK_RESULT,
        }}
        onState={(s) => states.push(s)}
      />,
    );

    expect(states[0]).toEqual({
      isExecuting: false,
      lastResult: null,
      error: null,
      executionCount: 0,
    });
  });

  it("Zod tool succeeds when execute() is called with no args", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "noop",
          description: "No-arg tool",
          input: z.object({}),
          handler: async () => OK_RESULT,
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    await act(async () => {
      await executeRef.current?.();
    });

    expect(document.querySelector("[data-testid='count']")?.textContent).toBe("1");
  });

  it("updates state on successful execution", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;
    const result = makeResult("hello world");

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => result,
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    await act(async () => {
      await executeRef.current?.();
    });

    await waitFor(() => {
      expect(document.querySelector("[data-testid='executing']")?.textContent).toBe("no");
    });

    expect(document.querySelector("[data-testid='count']")?.textContent).toBe("1");
    expect(document.querySelector("[data-testid='result']")?.textContent).toBe("hello world");
  });

  it("sets error state on handler error and re-throws", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => {
            throw new Error("handler failed");
          },
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    let caughtError: Error | undefined;
    await act(async () => {
      try {
        await executeRef.current?.();
      } catch (e) {
        caughtError = e as Error;
      }
    });

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toBe("handler failed");

    expect(document.querySelector("[data-testid='error']")?.textContent).toBe("handler failed");
  });

  it("executionCount does NOT increment on handler failure", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => {
            throw new Error("fail");
          },
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    await act(async () => {
      try {
        await executeRef.current?.();
      } catch {
        // expected
      }
    });

    expect(document.querySelector("[data-testid='count']")?.textContent).toBe("0");
    expect(document.querySelector("[data-testid='error']")?.textContent).toBe("fail");
  });

  it("sets error state on Zod validation error and re-throws", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          input: z.object({ name: z.string() }),
          handler: async () => OK_RESULT,
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    let caughtError: Error | undefined;
    await act(async () => {
      try {
        await executeRef.current?.({ name: 123 as unknown as string });
      } catch (e) {
        caughtError = e as Error;
      }
    });

    expect(caughtError).toBeDefined();
    expect(document.querySelector("[data-testid='error']")?.textContent).not.toBe("none");
  });

  it("calls onSuccess and onError callbacks (latest via ref)", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;
    const onSuccess = vi.fn();
    const onError = vi.fn();

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => OK_RESULT,
          onSuccess,
          onError,
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    await act(async () => {
      await executeRef.current?.();
    });

    expect(onSuccess).toHaveBeenCalledWith(OK_RESULT);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reset restores initial state", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;
    const resetRef = { current: null } as React.MutableRefObject<ResetFn | null>;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => OK_RESULT,
        }}
        onExecuteRef={executeRef}
        onResetRef={resetRef}
      />,
    );

    await waitForRegistration();

    await act(async () => {
      await executeRef.current?.();
    });

    await waitFor(() => {
      expect(document.querySelector("[data-testid='count']")?.textContent).toBe("1");
    });

    act(() => {
      resetRef.current?.();
    });

    await waitFor(() => {
      expect(document.querySelector("[data-testid='count']")?.textContent).toBe("0");
      expect(document.querySelector("[data-testid='result']")?.textContent).toBe("null");
    });
  });

  it("overlapping executions keep isExecuting true until all complete", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;
    let resolve1: (v: CallToolResult) => void;
    let resolve2: (v: CallToolResult) => void;
    let callCount = 0;

    renderWithProvider(
      <ToolComponent
        config={{
          name: "slow",
          description: "Slow tool",
          handler: () => {
            callCount++;
            return new Promise<CallToolResult>((r) => {
              if (callCount === 1) resolve1 = r;
              else resolve2 = r;
            });
          },
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    // Start two concurrent executions
    let p1: Promise<CallToolResult> | undefined;
    let p2: Promise<CallToolResult> | undefined;
    act(() => {
      p1 = executeRef.current?.();
      p2 = executeRef.current?.();
    });

    await waitFor(() => {
      expect(document.querySelector("[data-testid='executing']")?.textContent).toBe("yes");
    });

    // Complete first — isExecuting should still be true
    await act(async () => {
      resolve1(makeResult("first"));
      await p1;
    });

    expect(document.querySelector("[data-testid='executing']")?.textContent).toBe("yes");

    // Complete second — now isExecuting should be false
    await act(async () => {
      resolve2(makeResult("second"));
      await p2;
    });

    expect(document.querySelector("[data-testid='executing']")?.textContent).toBe("no");
  });
});

// ─── MCP integration ─────────────────────────────────────────────

describe("MCP integration", () => {
  it("executeTool calls handler and returns result JSON", async () => {
    renderWithProvider(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          input: z.object({ name: z.string() }),
          handler: async ({ name }: Record<string, unknown>) => makeResult(`hello ${name}`),
        }}
      />,
    );

    await waitForRegistration();

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool(
        "greet",
        JSON.stringify({ name: "world" }),
      );
    });

    const result = JSON.parse(resultJson ?? "null");
    expect(result.content[0].text).toBe("hello world");
  });

  it("handler error returns isError through MCP (no throw)", async () => {
    renderWithProvider(
      <ToolComponent
        config={{
          name: "fail",
          description: "Always fails",
          handler: async () => {
            throw new Error("boom");
          },
        }}
      />,
    );

    await waitForRegistration();

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool("fail", "{}");
    });

    const result = JSON.parse(resultJson ?? "null");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error: boom");

    expect(document.querySelector("[data-testid='count']")?.textContent).toBe("0");
  });

  it("latest handler is always called via ref", async () => {
    const handler1 = vi.fn(async () => makeResult("v1"));
    const handler2 = vi.fn(async () => makeResult("v2"));

    const { rerender } = render(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            handler: handler1,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    // Update handler without changing registration deps
    rerender(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            handler: handler2,
          }}
        />
      </WebMCPProvider>,
    );

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool("greet", "{}");
    });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();

    const result = JSON.parse(resultJson ?? "null");
    expect(result.content[0].text).toBe("v2");
  });
});

// ─── SSR safety ──────────────────────────────────────────────────

describe("SSR safety", () => {
  it("renderToString does not throw and returns initial state markup", () => {
    const html = renderToString(
      <WebMCPProvider name="test" version="1.0">
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    expect(html).toContain("no"); // isExecuting: no
    expect(html).toContain("none"); // error: none
    expect(html).toContain("0"); // executionCount: 0
  });

  it("registration effect does not fire during SSR", () => {
    // During SSR, typeof navigator is "undefined" in Node, but jsdom provides it.
    // Verify no tool is registered synchronously during renderToString.
    // After renderToString, document.modelContext should not exist (no provider effect ran).
    const prevMc = document.modelContext;
    delete document.modelContext;

    try {
      renderToString(
        <WebMCPProvider name="test" version="1.0">
          <ToolComponent
            config={{
              name: "greet",
              description: "Say hello",
              handler: async () => OK_RESULT,
            }}
          />
        </WebMCPProvider>,
      );

      // No modelContext should exist — effects don't run during renderToString
      expect(document.modelContext).toBeUndefined();
    } finally {
      if (prevMc) {
        Object.defineProperty(document, "modelContext", {
          value: prevMc,
          configurable: true,
          enumerable: true,
          writable: false,
        });
      }
    }
  });
});

// ─── Unmount safety ──────────────────────────────────────────────

describe("unmount safety", () => {
  it("does not update state after unmount during async handler", async () => {
    const executeRef = { current: null } as React.MutableRefObject<ExecuteFn | null>;
    let resolveHandler: (v: CallToolResult) => void;

    const { unmount } = renderWithProvider(
      <ToolComponent
        config={{
          name: "slow",
          description: "Slow tool",
          handler: () =>
            new Promise<CallToolResult>((r) => {
              resolveHandler = r;
            }),
        }}
        onExecuteRef={executeRef}
      />,
    );

    await waitForRegistration();

    // Start execution, then unmount before it completes
    let executePromise: Promise<CallToolResult> | undefined;
    act(() => {
      executePromise = executeRef.current?.();
    });

    unmount();

    // Spy on console.error to verify no "setState on unmounted component" warning
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolve after unmount
    await act(async () => {
      resolveHandler(OK_RESULT);
      await executePromise;
    });

    // React 18 removed the warning, but we verify no errors occurred
    const relevantErrors = errorSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("unmounted"),
    );
    expect(relevantErrors).toHaveLength(0);
  });
});

// ─── Provider warning ────────────────────────────────────────────

describe("provider warning", () => {
  it("warns when used outside WebMCPProvider", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => OK_RESULT,
        }}
      />,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("useMcpTool is being used outside <WebMCPProvider>"),
    );
  });
});

// ─── Registration error routing + ownership ──────────────────────

describe("registration error routing + ownership", () => {
  it("routes a registration rejection into state.error and onError", async () => {
    const onError = vi.fn();
    function Tool() {
      const { state } = useMcpTool({
        name: "dup",
        description: "d",
        onError,
        handler: () => ({ content: [{ type: "text", text: "ok" }] }),
      });
      return <span data-testid="err">{state.error?.message ?? ""}</span>;
    }

    // Install the polyfill first, then pre-register "dup" directly so the hook's
    // own registration rejects with a duplicate-name InvalidStateError.
    const { rerender } = render(
      <WebMCPProvider name="t" version="1">
        <span />
      </WebMCPProvider>,
    );
    await waitFor(() => expect(document.modelContext).toBeDefined());
    await (document.modelContext as NonNullable<typeof document.modelContext>).registerTool({
      name: "dup",
      description: "incumbent",
      execute: () => ({ content: [{ type: "text", text: "x" }] }),
    });

    rerender(
      <WebMCPProvider name="t" version="1">
        <Tool />
      </WebMCPProvider>,
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0].name).toBe("InvalidStateError");
    await waitFor(() =>
      expect(document.querySelector("[data-testid='err']")?.textContent).not.toBe(""),
    );
  });

  it("does NOT route AbortError (lifecycle teardown) into onError", async () => {
    const onError = vi.fn();
    function Tool() {
      useMcpTool({
        name: "abortable",
        description: "d",
        onError,
        handler: () => ({ content: [{ type: "text", text: "ok" }] }),
      });
      return null;
    }
    const { unmount } = render(
      <WebMCPProvider name="t" version="1">
        <Tool />
      </WebMCPProvider>,
    );
    await waitFor(() => expect(navigator.modelContextTesting?.listTools() ?? []).toHaveLength(1));
    unmount();
    await act(async () => {});
    expect(onError).not.toHaveBeenCalled();
  });

  it("duplicate-name loser does not evict the winner's registration", async () => {
    const winnerError = vi.fn();
    const loserError = vi.fn();
    function Pair() {
      useMcpTool({
        name: "shared",
        description: "winner",
        onError: winnerError,
        handler: () => ({ content: [{ type: "text", text: "winner" }] }),
      });
      useMcpTool({
        name: "shared",
        description: "loser",
        onError: loserError,
        handler: () => ({ content: [{ type: "text", text: "loser" }] }),
      });
      return null;
    }

    render(
      <WebMCPProvider name="t" version="1">
        <Pair />
      </WebMCPProvider>,
    );

    await waitFor(() => expect(loserError).toHaveBeenCalled());
    expect(loserError.mock.calls[0][0].name).toBe("InvalidStateError");

    // Winner stays registered; the loser never evicted it.
    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools.filter((t) => t.name === "shared")).toHaveLength(1);
    expect(winnerError).not.toHaveBeenCalled();
  });
});

// ─── Signal-only native API (Chrome 148+) ────────────────────────

describe("signal-only native API (Chrome 148+)", () => {
  type ToolEntry = { name: string; abortCleanup: () => void };

  function installSignalOnlyNative() {
    const registered: ToolEntry[] = [];

    const native = {
      registerTool(
        tool: { name: string; [key: string]: unknown },
        opts?: { signal?: AbortSignal },
      ) {
        const entry: ToolEntry = { name: tool.name, abortCleanup: () => {} };
        registered.push(entry);
        if (opts?.signal) {
          const handler = () => {
            const idx = registered.findIndex((t) => t.name === tool.name);
            if (idx !== -1) registered.splice(idx, 1);
          };
          opts.signal.addEventListener("abort", handler, { once: true });
          entry.abortCleanup = () => opts.signal?.removeEventListener("abort", handler);
        }
        return Promise.resolve(undefined);
      },
    };

    Object.defineProperty(document, "modelContext", {
      value: native,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    return registered;
  }

  function deleteModelContext() {
    const desc = Object.getOwnPropertyDescriptor(document, "modelContext");
    if (desc) {
      Object.defineProperty(document, "modelContext", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      delete document.modelContext;
    }
  }

  afterEach(() => {
    deleteModelContext();
  });

  it("registers and unregisters via abort on mount/unmount", async () => {
    const registered = installSignalOnlyNative();

    const { unmount } = render(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => OK_RESULT,
        }}
      />,
    );

    await act(async () => {});
    expect(registered.some((t) => t.name === "greet")).toBe(true);

    unmount();
    await act(async () => {});
    expect(registered.some((t) => t.name === "greet")).toBe(false);
  });

  it("handles StrictMode double-mount with signal-only API", async () => {
    const registered = installSignalOnlyNative();

    const { unmount } = render(
      <StrictMode>
        <ToolComponent
          config={{
            name: "greet",
            description: "Say hello",
            handler: async () => OK_RESULT,
          }}
        />
      </StrictMode>,
    );

    await act(async () => {});
    const greetTools = registered.filter((t) => t.name === "greet");
    expect(greetTools.length).toBe(1);

    unmount();
    await act(async () => {});
    expect(registered.some((t) => t.name === "greet")).toBe(false);
  });

  it("re-registers with fresh signal on prop change", async () => {
    const registered = installSignalOnlyNative();
    const registerSpy = vi.spyOn(
      document.modelContext as NonNullable<typeof document.modelContext>,
      "registerTool",
    );

    const { rerender } = render(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello",
          handler: async () => OK_RESULT,
        }}
      />,
    );

    await act(async () => {});
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registered.some((t) => t.name === "greet")).toBe(true);

    // Change description to trigger re-registration
    rerender(
      <ToolComponent
        config={{
          name: "greet",
          description: "Say hello v2",
          handler: async () => OK_RESULT,
        }}
      />,
    );

    await act(async () => {});
    expect(registerSpy).toHaveBeenCalledTimes(2);
    // Old signal aborted old entry, new entry registered
    expect(registered.filter((t) => t.name === "greet").length).toBe(1);
  });
});

describe("native registerTool compatibility (void return / sync throw)", () => {
  function installNative(registerTool: () => unknown) {
    const native = { registerTool };
    Object.defineProperty(document, "modelContext", {
      value: native,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  function deleteModelContext() {
    const desc = Object.getOwnPropertyDescriptor(document, "modelContext");
    if (desc) {
      Object.defineProperty(document, "modelContext", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      delete document.modelContext;
    }
  }

  afterEach(() => {
    deleteModelContext();
  });

  it("does not crash when native registerTool returns void (undefined)", async () => {
    installNative(() => undefined);

    const onState = vi.fn<(state: ReturnType<typeof useMcpTool>["state"]) => void>();

    expect(() => {
      renderWithProvider(
        <ToolComponent
          config={{
            name: "void_tool",
            description: "d",
            handler: () => ({ content: [{ type: "text", text: "ok" }] }),
          }}
          onState={onState}
        />,
      );
    }).not.toThrow();

    await act(async () => {});

    const last = onState.mock.calls.at(-1)?.[0];
    expect(last?.error).toBeNull();
  });

  it("routes a synchronous throw from native registerTool into state.error and onError", async () => {
    installNative(() => {
      throw new DOMException("Duplicate tool name", "InvalidStateError");
    });

    const onError = vi.fn();
    const onState = vi.fn<(state: ReturnType<typeof useMcpTool>["state"]) => void>();

    renderWithProvider(
      <ToolComponent
        config={{
          name: "dup_tool",
          description: "d",
          handler: () => ({ content: [{ type: "text", text: "ok" }] }),
          onError,
        }}
        onState={onState}
      />,
    );

    await act(async () => {});

    expect(onError).toHaveBeenCalled();
    const passed = onError.mock.calls[0]?.[0] as Error;
    expect(passed.name).toBe("InvalidStateError");

    const last = onState.mock.calls.at(-1)?.[0];
    expect(last?.error).not.toBeNull();
    expect(last?.error?.name).toBe("InvalidStateError");
  });

  it("ignores a synchronous AbortError throw from native registerTool", async () => {
    installNative(() => {
      throw new DOMException("aborted", "AbortError");
    });

    const onError = vi.fn();
    const onState = vi.fn<(state: ReturnType<typeof useMcpTool>["state"]) => void>();

    renderWithProvider(
      <ToolComponent
        config={{
          name: "abort_tool",
          description: "d",
          handler: () => ({ content: [{ type: "text", text: "ok" }] }),
          onError,
        }}
        onState={onState}
      />,
    );

    await act(async () => {});

    expect(onError).not.toHaveBeenCalled();
    const last = onState.mock.calls.at(-1)?.[0];
    expect(last?.error).toBeNull();
  });
});

// ─── Execution signal (Chrome 153+ shape) ────────────────────────

describe("execution signal", () => {
  function installFakeNative() {
    const captured: ToolDescriptor[] = [];
    const fake = {
      registerTool: (tool: ToolDescriptor) => {
        captured.push(tool);
        return Promise.resolve(undefined);
      },
    };
    Object.defineProperty(document, "modelContext", { value: fake, configurable: true });
    return {
      captured,
      uninstall: () => {
        delete (document as { modelContext?: unknown }).modelContext;
      },
    };
  }

  it("direct execute() passes a non-aborted AbortSignal to the handler", async () => {
    const seen: Array<{ signal: AbortSignal }> = [];
    const executeRef = { current: null as ExecuteFn | null };
    renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_direct",
          description: "d",
          handler: async (_args, ctx) => {
            seen.push(ctx);
            return OK_RESULT;
          },
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    await act(async () => {
      await executeRef.current?.();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].signal.aborted).toBe(false);
  });

  it("direct execute() forwards a caller-provided signal", async () => {
    let received: AbortSignal | undefined;
    const executeRef = { current: null as ExecuteFn | null };
    renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_forward",
          description: "d",
          handler: async (_args, { signal }) => {
            received = signal;
            return OK_RESULT;
          },
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    const controller = new AbortController();
    await act(async () => {
      await executeRef.current?.({}, { signal: controller.signal });
    });
    expect(received).toBe(controller.signal);
  });

  it("aborted execution is cancellation: rethrows but no state.error, no onError", async () => {
    const onError = vi.fn();
    const executeRef = { current: null as ExecuteFn | null };
    const { getByTestId } = renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_cancel",
          description: "d",
          onError,
          handler: (_args, { signal }) =>
            new Promise<CallToolResult>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    const controller = new AbortController();
    const exec = executeRef.current as ExecuteFn;
    let rejected: unknown = null;
    let promise!: Promise<CallToolResult>;
    act(() => {
      promise = exec({}, { signal: controller.signal });
      promise.catch((e: unknown) => {
        rejected = e;
      });
    });
    await act(async () => {
      controller.abort(new DOMException("user cancelled", "AbortError"));
      await promise.catch(() => {});
    });
    expect((rejected as { name?: string })?.name).toBe("AbortError");
    expect(onError).not.toHaveBeenCalled();
    expect(getByTestId("error").textContent).toBe("none");
    expect(getByTestId("executing").textContent).toBe("no");
  });

  it("descriptor execute forwards Chrome's signal and treats abort as cancellation", async () => {
    const { captured, uninstall } = installFakeNative();
    try {
      const onError = vi.fn();
      const { getByTestId } = renderWithProvider(
        <ToolComponent
          config={{
            name: "sig_native",
            description: "d",
            onError,
            handler: (_args, { signal }) =>
              new Promise<CallToolResult>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          }}
        />,
      );
      await waitFor(() => expect(captured.length).toBeGreaterThan(0));
      const controller = new AbortController();
      let result!: Promise<CallToolResult>;
      act(() => {
        result = Promise.resolve(captured[0].execute({}, { signal: controller.signal }));
      });
      let settled: CallToolResult | undefined;
      await act(async () => {
        controller.abort();
        settled = await result;
      });
      // The agent path resolves with an isError result rather than rejecting.
      expect(settled?.isError).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(getByTestId("error").textContent).toBe("none");
    } finally {
      uninstall();
    }
  });

  it("bare descriptor execute (Chrome <=152 shape) still provides a real signal", async () => {
    const { captured, uninstall } = installFakeNative();
    try {
      let ctxSeen: { signal: AbortSignal } | undefined;
      renderWithProvider(
        <ToolComponent
          config={{
            name: "sig_bare",
            description: "d",
            handler: async (_args, ctx) => {
              ctxSeen = ctx;
              return OK_RESULT;
            },
          }}
        />,
      );
      await waitFor(() => expect(captured.length).toBeGreaterThan(0));
      await act(async () => {
        // Chrome <=152 calls execute with a single argument.
        await (captured[0].execute as unknown as (input: Record<string, unknown>) => unknown)({});
      });
      expect(ctxSeen?.signal).toBeInstanceOf(AbortSignal);
      expect(ctxSeen?.signal.aborted).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("non-abort failures still set state.error and fire onError", async () => {
    const onError = vi.fn();
    const executeRef = { current: null as ExecuteFn | null };
    const { getByTestId } = renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_realfail",
          description: "d",
          onError,
          handler: async () => {
            throw new Error("genuine failure");
          },
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    const controller = new AbortController(); // present but never aborted
    const exec = executeRef.current as ExecuteFn;
    await act(async () => {
      await exec({}, { signal: controller.signal }).catch(() => {});
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getByTestId("error").textContent).toBe("genuine failure");
  });
});
