import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { _resetPolyfillConsumerCount, useWebMCPStatus, WebMCPProvider } from "../context";
import { _resetToolOwners, useMcpTool } from "../hooks/useMcpTool";
import { cleanupPolyfill } from "../polyfill";
import type { CallToolResult, McpToolConfigJsonSchema, McpToolConfigZod } from "../types";
import { _resetWarnings } from "../utils/warn";

// ─── Helpers ──────────────────────────────────────────────────────

const OK_RESULT: CallToolResult = {
  content: [{ type: "text", text: "ok" }],
};

function makeResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function AvailabilityDisplay() {
  const { available } = useWebMCPStatus();
  return <span data-testid="smoke-available">{available ? "yes" : "no"}</span>;
}

type ToolConfig = McpToolConfigZod<z.ZodRawShape> | McpToolConfigJsonSchema;

function SmokeToolComponent({ config }: { config: ToolConfig }) {
  const { state } = useMcpTool(config as McpToolConfigJsonSchema);
  return (
    <div>
      <span data-testid="smoke-executing">{state.isExecuting ? "yes" : "no"}</span>
      <span data-testid="smoke-error">{state.error?.message ?? "none"}</span>
      <span data-testid="smoke-count">{state.executionCount}</span>
      <span data-testid="smoke-result">
        {state.lastResult
          ? state.lastResult.content.map((c) => ("text" in c ? c.text : "")).join("")
          : "null"}
      </span>
    </div>
  );
}

async function waitForRegistration() {
  await waitFor(() => {
    expect(navigator.modelContextTesting).toBeDefined();
  });
  await act(async () => {});
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

// ─── SSR + client mount availability ──────────────────────────────

describe("smoke: SSR + client mount availability", () => {
  it("server renders available=false, client mount transitions to true", async () => {
    const tree = (
      <WebMCPProvider name="smoke" version="1.0">
        <AvailabilityDisplay />
      </WebMCPProvider>
    );

    // Server: effects don't run, availability is false
    const html = renderToString(tree);
    expect(html).toContain("no");
    expect(html).not.toContain("yes");

    // Client: effect installs polyfill, availability transitions to true
    const { getByTestId } = render(tree);
    await waitFor(() => {
      expect(getByTestId("smoke-available")).toHaveTextContent("yes");
    });
  });
});

// ─── Tool registration lifecycle ──────────────────────────────────

describe("smoke: tool registration lifecycle", () => {
  it("tool visible in listTools after mount, removed on unmount", async () => {
    const { unmount } = render(
      <WebMCPProvider name="smoke" version="1.0">
        <SmokeToolComponent
          config={{
            name: "smoke_greet",
            description: "Smoke test greeter",
            input: z.object({ name: z.string() }),
            handler: async () => OK_RESULT,
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("smoke_greet");
    expect(tools[0].description).toBe("Smoke test greeter");

    unmount();

    // Provider cleanup removes the polyfill, so the tool is gone.
    await waitFor(() => expect(navigator.modelContextTesting?.listTools() ?? []).toHaveLength(0));
  });
});

// ─── StrictMode safety ────────────────────────────────────────────

describe("smoke: StrictMode safety", () => {
  it("one tool registered after double-mount, removed on real unmount", async () => {
    const { unmount } = render(
      <StrictMode>
        <WebMCPProvider name="smoke" version="1.0">
          <SmokeToolComponent
            config={{
              name: "strict_tool",
              description: "StrictMode smoke",
              input: z.object({ value: z.number() }),
              handler: async () => OK_RESULT,
            }}
          />
        </WebMCPProvider>
      </StrictMode>,
    );

    await waitForRegistration();

    const tools = navigator.modelContextTesting?.listTools() ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("strict_tool");

    unmount();

    await waitFor(() => expect(navigator.modelContextTesting?.listTools() ?? []).toHaveLength(0));
  });
});

// ─── executeTool through testing shim ─────────────────────────────

describe("smoke: executeTool through testing shim", () => {
  it("Zod path: handler result returned and hook state updated", async () => {
    render(
      <WebMCPProvider name="smoke" version="1.0">
        <SmokeToolComponent
          config={{
            name: "zod_greet",
            description: "Zod greeter",
            input: z.object({ name: z.string() }),
            handler: async ({ name }: Record<string, unknown>) => makeResult(`hello ${name}`),
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool(
        "zod_greet",
        JSON.stringify({ name: "smoke" }),
      );
    });

    // Returned JSON is correct
    const result = JSON.parse(resultJson ?? "null");
    expect(result.content[0].text).toBe("hello smoke");
    expect(result.isError).toBeUndefined();

    // Hook state propagated back to React component
    expect(document.querySelector("[data-testid='smoke-result']")?.textContent).toBe("hello smoke");
    expect(document.querySelector("[data-testid='smoke-count']")?.textContent).toBe("1");
  });

  it("JSON Schema path: handler result returned and hook state updated", async () => {
    render(
      <WebMCPProvider name="smoke" version="1.0">
        <SmokeToolComponent
          config={{
            name: "json_greet",
            description: "JSON Schema greeter",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            handler: async (args) => makeResult(`hi ${args.name}`),
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool(
        "json_greet",
        JSON.stringify({ name: "test" }),
      );
    });

    const result = JSON.parse(resultJson ?? "null");
    expect(result.content[0].text).toBe("hi test");
    expect(result.isError).toBeUndefined();

    expect(document.querySelector("[data-testid='smoke-result']")?.textContent).toBe("hi test");
    expect(document.querySelector("[data-testid='smoke-count']")?.textContent).toBe("1");
  });
});

// ─── External execution state propagation ─────────────────────────

describe("smoke: external execution state propagation", () => {
  it("isExecuting reflects in-flight executeTool, lastResult updates on completion", async () => {
    let resolveHandler!: (v: CallToolResult) => void;

    render(
      <WebMCPProvider name="smoke" version="1.0">
        <SmokeToolComponent
          config={{
            name: "slow_tool",
            description: "Slow smoke tool",
            handler: () =>
              new Promise<CallToolResult>((resolve) => {
                resolveHandler = resolve;
              }),
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    // Initial state
    expect(document.querySelector("[data-testid='smoke-executing']")?.textContent).toBe("no");

    // Start executeTool without awaiting — observe intermediate state
    let executePromise: Promise<string | null | undefined> | undefined;
    act(() => {
      executePromise = navigator.modelContextTesting?.executeTool("slow_tool", "{}");
    });

    await waitFor(() => {
      expect(document.querySelector("[data-testid='smoke-executing']")?.textContent).toBe("yes");
    });

    // Resolve handler and await completion
    await act(async () => {
      resolveHandler(makeResult("done"));
      await executePromise;
    });

    expect(document.querySelector("[data-testid='smoke-executing']")?.textContent).toBe("no");
    expect(document.querySelector("[data-testid='smoke-result']")?.textContent).toBe("done");
    expect(document.querySelector("[data-testid='smoke-count']")?.textContent).toBe("1");
  });

  it("handler failure: executeTool returns isError, hook state shows error", async () => {
    render(
      <WebMCPProvider name="smoke" version="1.0">
        <SmokeToolComponent
          config={{
            name: "fail_tool",
            description: "Failing smoke tool",
            handler: async () => {
              throw new Error("smoke failure");
            },
          }}
        />
      </WebMCPProvider>,
    );

    await waitForRegistration();

    let resultJson: string | null | undefined;
    await act(async () => {
      resultJson = await navigator.modelContextTesting?.executeTool("fail_tool", "{}");
    });

    // executeTool resolves (not rejects) with isError result
    const result = JSON.parse(resultJson ?? "null");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("smoke failure");

    // Hook state reflects the error
    expect(document.querySelector("[data-testid='smoke-error']")?.textContent).toBe(
      "smoke failure",
    );
    expect(document.querySelector("[data-testid='smoke-executing']")?.textContent).toBe("no");
  });
});
