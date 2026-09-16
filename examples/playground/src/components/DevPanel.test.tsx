import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupPolyfill, installPolyfill } from "../../../../src/polyfill";
import type { ModelContext } from "../../../../src/types";
import { DevPanel } from "./DevPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  cleanupPolyfill();
});

async function setup(version: "object" | "string" | "polyfill" = "object") {
  installPolyfill();
  const mc = document.modelContext as ModelContext &
    Required<Pick<ModelContext, "getTools" | "executeTool">>;
  const handler = vi.fn((input: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: `Received ${input.message}` }],
  }));
  await mc.registerTool({ name: "echo", description: "Echo input", execute: handler });
  const execute = mc.executeTool.bind(mc);
  const call = vi.spyOn(mc, "executeTool").mockImplementation((tool, input, options) => {
    if (version === "object" && typeof input === "string") {
      return Promise.reject(new TypeError("Input arguments must be an object"));
    }
    if (version === "string" && typeof input !== "string") {
      return Promise.reject(new DOMException("Failed to parse input arguments", "UnknownError"));
    }
    return execute(tool, input, options);
  });
  render(<DevPanel />);
  await screen.findByRole("button", { name: "Execute" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: '{"message":"hello"}' } });
  return { mc, handler, call };
}

it.each([
  "object",
  "polyfill",
] as const)("executes an object once with the %s API", async (version) => {
  const { handler, call } = await setup(version);
  fireEvent.click(screen.getByRole("button", { name: "Execute" }));
  await screen.findByText(/Received hello/);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][1]).toEqual({ message: "hello" });
  expect(handler).toHaveBeenCalledTimes(1);
});

it("retries only the older Chrome parse failure with the same tool and signal", async () => {
  const { handler, call } = await setup("string");
  fireEvent.click(screen.getByRole("button", { name: "Execute" }));
  await screen.findByText(/Received hello/);
  expect(call).toHaveBeenCalledTimes(2);
  const [first, retry] = call.mock.calls;
  expect(first[1]).toEqual({ message: "hello" });
  expect(retry[1]).toBe('{"message":"hello"}');
  expect(retry[0]).toBe(first[0]);
  expect(retry[2]?.signal).toBe(first[2]?.signal);
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([
  new TypeError("Tool failed"),
  new DOMException("Tool execution failed: Failed to parse input", "UnknownError"),
  new DOMException("Failed to parse input arguments", "AbortError"),
])("displays %s without retrying", async (error) => {
  const { call } = await setup();
  call.mockRejectedValue(error);
  fireEvent.click(screen.getByRole("button", { name: "Execute" }));
  await screen.findByText(error.message);
  expect(call).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Execute" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("does not retry a parse failure after cancellation", async () => {
  const { call } = await setup();
  let rejectCall!: (error: Error) => void;
  call.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectCall = reject;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Execute" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(call.mock.calls[0][2]?.signal?.aborted).toBe(true);
  rejectCall(new DOMException("Failed to parse input arguments", "UnknownError"));
  await screen.findByText("Failed to parse input arguments");
  expect(call).toHaveBeenCalledTimes(1);
});

it.each([
  "not json",
  "null",
  "42",
  '"a string"',
])("rejects invalid input %s before calling the API", async (input) => {
  const { handler, call } = await setup();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: input } });
  fireEvent.click(screen.getByRole("button", { name: "Execute" }));
  await screen.findByText("Error", { selector: "summary" });
  expect(call).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
