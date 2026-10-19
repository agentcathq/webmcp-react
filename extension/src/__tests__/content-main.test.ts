import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import type { PageMessage, PageModelContext, PageToolResultMessage } from "../types";

const tool = { name: "echo", description: "Echo input" };
const result = '{"content":[{"type":"text","text":"hello"}]}';
let listeners: MockInstance<typeof window.addEventListener>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  listeners = vi.spyOn(window, "addEventListener");
});

afterEach(() => {
  for (const [type, listener] of listeners.mock.calls) {
    window.removeEventListener(type, listener);
  }
  delete document.modelContext;
  delete navigator.modelContextTesting;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pageApi(mode: "modern" | "legacy" | "polyfill") {
  const handled: unknown[] = [];
  const execute = vi.fn<NonNullable<PageModelContext["executeTool"]>>(async (_tool, input) => {
    if (mode === "modern" && typeof input === "string") {
      throw new TypeError("Input must be an object");
    }
    if (mode === "legacy") {
      const serialized = String(input);
      try {
        handled.push(JSON.parse(serialized));
      } catch {
        throw new DOMException("Failed to parse input arguments", "UnknownError");
      }
    } else {
      handled.push(JSON.parse(typeof input === "string" ? input : JSON.stringify(input)));
    }
    return result;
  });
  document.modelContext = Object.assign(new EventTarget(), {
    getTools: async () => [tool],
    executeTool: execute,
  });
  return { execute, handled };
}

async function loadBridge() {
  const posted: PageMessage[] = [];
  vi.spyOn(window, "postMessage").mockImplementation((message) => posted.push(message));
  await import("../content-main");
  function send(data: PageMessage) {
    window.dispatchEvent(new MessageEvent("message", { source: window, data }));
  }
  return {
    call(argsJson = '{"message":"hello"}') {
      send({ type: "WEBMCP_EXECUTE_TOOL", requestId: "request-1", toolName: "echo", argsJson });
    },
    cancel() {
      send({ type: "WEBMCP_CANCEL_TOOL", requestId: "request-1" });
    },
    async response() {
      return vi.waitFor(() => {
        const response = posted.find(
          (message): message is PageToolResultMessage =>
            message.type === "WEBMCP_TOOL_RESULT" && message.requestId === "request-1",
        );
        if (!response) throw new Error("Waiting for bridge response");
        return response;
      });
    },
  };
}

it.each(["modern", "polyfill"] as const)("passes objects directly to the %s API", async (mode) => {
  const { execute, handled } = pageApi(mode);
  const bridge = await loadBridge();
  bridge.call();
  expect(await bridge.response()).toEqual({
    type: "WEBMCP_TOOL_RESULT",
    requestId: "request-1",
    result,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0][1]).toEqual({ message: "hello" });
  expect(handled).toEqual([{ message: "hello" }]);
});

it("retries the legacy parse failure with the same tool and signal, executing once", async () => {
  const { execute, handled } = pageApi("legacy");
  const bridge = await loadBridge();
  bridge.call();
  expect((await bridge.response()).result).toBe(result);
  expect(execute).toHaveBeenCalledTimes(2);
  const [first, retry] = execute.mock.calls;
  expect(first[1]).toEqual({ message: "hello" });
  expect(retry[1]).toBe('{"message":"hello"}');
  expect(retry[0]).toBe(first[0]);
  expect(retry[2]?.signal).toBe(first[2]?.signal);
  expect(handled).toEqual([{ message: "hello" }]);
});

it.each([
  ["legacy", '{"toString":"hello"}', { toString: "hello" }],
  ["modern", '{"toString":"hello"}', { toString: "hello" }],
  ["polyfill", '{"toString":"hello"}', { toString: "hello" }],
  ["legacy", '["{}"]', ["{}"]],
  ["modern", '["{}"]', ["{}"]],
  ["polyfill", '["{}"]', ["{}"]],
] as const)("preserves %s input %s through serialization", async (mode, argsJson, input) => {
  const { handled } = pageApi(mode);
  const bridge = await loadBridge();
  bridge.call(argsJson);
  expect((await bridge.response()).result).toBe(result);
  expect(handled).toEqual([input]);
  expect(Object.getOwnPropertySymbols(handled[0] as object)).toEqual([]);
});

it.each([
  new TypeError("Tool failed"),
  new DOMException("Tool execution failed: Failed to parse input", "UnknownError"),
  new DOMException("Failed to parse input arguments", "AbortError"),
])("reports %s without executing the tool twice", async (error) => {
  const { execute } = pageApi("polyfill");
  let executions = 0;
  execute.mockImplementation(async () => {
    executions++;
    throw error;
  });
  const bridge = await loadBridge();
  bridge.call();
  expect((await bridge.response()).error).toContain(error.message);
  expect(executions).toBe(1);
});

it.each([
  "not json",
  "null",
  "42",
  '"a string"',
])("rejects invalid input %s before execution", async (input) => {
  const { execute, handled } = pageApi("polyfill");
  const bridge = await loadBridge();
  bridge.call(input);
  expect((await bridge.response()).error).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
  expect(handled).toEqual([]);
});

it("does not retry a legacy parse failure after cancellation", async () => {
  const { execute } = pageApi("legacy");
  let reject!: (reason: unknown) => void;
  execute.mockImplementation(
    () =>
      new Promise((_resolve, rejectCall) => {
        reject = rejectCall;
      }),
  );
  const bridge = await loadBridge();
  bridge.call();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  bridge.cancel();
  expect(execute.mock.calls[0][2]?.signal?.aborted).toBe(true);
  reject(new DOMException("Failed to parse input arguments", "UnknownError"));
  expect((await bridge.response()).error).toContain("Failed to parse input");
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(["modern", "legacy"] as const)("cancels an in-flight %s call", async (mode) => {
  const { execute } = pageApi(mode);
  let started = false;
  execute.mockImplementation(async (_tool, input, options) => {
    if (mode === "legacy" && typeof input !== "string") {
      throw new DOMException("Failed to parse input arguments", "UnknownError");
    }
    const signal = options?.signal;
    if (!signal) throw new Error("Missing execution signal");
    started = true;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const bridge = await loadBridge();
  bridge.call();
  await vi.waitFor(() => expect(started).toBe(true));
  bridge.cancel();
  expect((await bridge.response()).error).toContain("abort");
  expect(execute).toHaveBeenCalledTimes(mode === "legacy" ? 2 : 1);
});

it("keeps JSON strings for pages exposing only the legacy testing API", async () => {
  const execute = vi.fn(async () => result);
  navigator.modelContextTesting = {
    listTools: () => [tool],
    executeTool: execute,
    registerToolsChangedCallback: () => {},
  };
  const bridge = await loadBridge();
  bridge.call();
  expect((await bridge.response()).result).toBe(result);
  expect(execute).toHaveBeenCalledWith("echo", '{"message":"hello"}', {
    signal: expect.any(AbortSignal),
  });
  expect(execute).toHaveBeenCalledTimes(1);
});
