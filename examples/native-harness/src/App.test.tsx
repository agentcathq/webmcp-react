import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupPolyfill, installPolyfill } from "../../../src/polyfill";
import type { ModelContext } from "../../../src/types";
import App from "./App";

vi.mock("webmcp-react", () => import("../../../src/index"));

afterEach(() => {
  cleanup();
  cleanupPolyfill();
  delete document.modelContext;
});

function nativeInputBoundary(mode: "modern" | "legacy" | Error, delayedAbort = false) {
  installPolyfill();
  const backing = document.modelContext!;
  const native = Object.assign(new EventTarget(), {
    registerTool: backing.registerTool.bind(backing),
    getTools: backing.getTools!.bind(backing),
    ontoolchange: null,
    executeTool: ((tool, input, options) => {
      if (typeof mode !== "string" && typeof input !== "string") return Promise.reject(mode);
      if (mode === "legacy" && typeof input !== "string") {
        return Promise.reject(new DOMException("Failed to parse input arguments", "UnknownError"));
      }
      if (mode === "modern") {
        if (input === undefined && options === undefined) input = {};
        if (input === null || (typeof input !== "object" && typeof input !== "function")) {
          return Promise.reject(new TypeError("Input must be an object"));
        }
        try {
          const serialized = JSON.stringify(input);
          if (serialized === undefined) throw new TypeError("Input is not JSON-serializable");
          input = JSON.parse(serialized);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (delayedAbort && options?.signal) {
        const toolController = new AbortController();
        return new Promise((resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => {
              reject(options.signal!.reason);
              setTimeout(() => toolController.abort(options.signal!.reason), 25);
            },
            { once: true },
          );
          backing.executeTool!(tool, input, { signal: toolController.signal }).then(
            resolve,
            reject,
          );
        });
      }
      // Browser execution crosses an asynchronous boundary before the handler starts.
      return Promise.resolve().then(() => backing.executeTool!(tool, input, options));
    }) satisfies NonNullable<ModelContext["executeTool"]>,
  });
  Object.defineProperty(document, "modelContext", { configurable: true, value: native });
}

async function run() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByTestId("detection")).not.toHaveTextContent("checking"));
  await act(async () => {
    fireEvent.click(screen.getByTestId("run-selftest"));
  });
  return screen.getByTestId("selftest-output");
}

async function expectFinished(output: HTMLElement) {
  await waitFor(() => expect(output).toHaveTextContent("already-aborted register rejects"));
  expect(output).not.toHaveTextContent("FAIL:");
  expect(output).toHaveTextContent("PASS: executeTool echo");
  expect(output).toHaveTextContent("PASS: executeTool add");
  expect(output).toHaveTextContent("PASS: unregister does not cancel in-flight execution");
  expect(output).toHaveTextContent(
    "PASS: aborted executeTool rejected (caller: AbortError, tool: AbortError)",
  );
  expect((await document.modelContext!.getTools!()).map((tool) => tool.name)).toEqual([
    "add",
    "echo",
  ]);
}

describe("native harness consumer probes", () => {
  it("reports polyfill object identity, input errors, and legacy compatibility", async () => {
    const output = await run();
    await expectFinished(output);
    expect(output).toHaveTextContent("PASS: polyfill preserves object input");
    expect(output).toHaveTextContent("PASS: undefined input defaults to an empty object");
    expect(output).toHaveTextContent(
      "PASS: undefined input and options defaults to an empty object",
    );
    expect(output).toHaveTextContent(
      "PASS: undefined with options input rejects UnknownError before handler",
    );
    expect(output).toHaveTextContent("PASS: omitted input defaults to an empty object");
    expect(output).toHaveTextContent("PASS: polyfill preserves circular input");
    expect(output).toHaveTextContent("PASS: polyfill preserves BigInt input");
    expect(output).toHaveTextContent("PASS: polyfill preserves toJSON undefined input");
    expect(output).toHaveTextContent("PASS: legacy JSON string accepted");
  });

  it("uses objects on modern native and reports legacy strings as rejected", async () => {
    nativeInputBoundary("modern");
    const output = await run();
    await expectFinished(output);
    expect(output).toHaveTextContent("PASS: object input serialized and cloned");
    expect(output).toHaveTextContent("PASS: undefined input defaults to an empty object");
    expect(output).toHaveTextContent(
      "PASS: undefined input and options defaults to an empty object",
    );
    expect(output).toHaveTextContent(
      "PASS: undefined with options input rejects TypeError before handler",
    );
    expect(output).toHaveTextContent("PASS: legacy JSON string rejects TypeError");
  });

  it("recognizes legacy native and starts flight probes before cancelling or unregistering", async () => {
    nativeInputBoundary("legacy");
    const output = await run();
    await expectFinished(output);
    expect(output).toHaveTextContent("INFO: legacy native requires JSON strings");
    expect(output).toHaveTextContent("INFO: modern input probes skipped on legacy native");
    expect(output).toHaveTextContent("PASS: legacy JSON string accepted");
  });

  it("waits for tool-side cancellation delivered after the caller rejects", async () => {
    nativeInputBoundary("legacy", true);
    const output = await run();
    await expectFinished(output);
    expect(output).not.toHaveTextContent("tool-side signal never fired");
  });

  it.each([
    new TypeError("Failed to parse input arguments"),
    new DOMException("Tool execution failed", "UnknownError"),
    new DOMException("cancelled", "AbortError"),
  ])("reports %s without falling back or leaking its synthetic registration", async (error) => {
    nativeInputBoundary(error);
    const output = await run();
    await waitFor(() => expect(output).toHaveTextContent("FAIL:"));
    expect(output).not.toHaveTextContent("legacy native requires JSON strings");
    expect(output).not.toHaveTextContent("PASS: executeTool echo");
    expect((await document.modelContext!.getTools!()).map((tool) => tool.name)).toEqual([
      "add",
      "echo",
    ]);
  });
});
