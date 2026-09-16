import type { ToolDescriptor } from "../types";
import { validateArgs } from "./validation";

function serializeResult(result: unknown): string {
  const text =
    typeof result === "object" && result !== null
      ? JSON.stringify(result) // throws on cycles — handled by the caller
      : String(result);
  return text === "" ? "Operation succeeded" : text;
}

/**
 * Execute with JSON-serialized inputs and a per-execution AbortSignal.
 * Legacy JSON strings remain supported. Unlike native Chrome, the polyfill
 * validates input against inputSchema (OperationError; spec issue #92).
 */
export function runTool(
  tool: ToolDescriptor,
  inputArguments?: string | object,
  callerSignal?: AbortSignal,
): Promise<string> {
  let parsed: unknown;
  if (typeof inputArguments === "string") {
    if (callerSignal?.aborted) {
      return Promise.reject(callerSignal.reason);
    }
    try {
      parsed = JSON.parse(inputArguments);
    } catch {
      return Promise.reject(new DOMException("Failed to parse input arguments", "UnknownError"));
    }
  } else {
    if (
      inputArguments === null ||
      (typeof inputArguments !== "object" && typeof inputArguments !== "function")
    ) {
      return Promise.reject(new TypeError("Input arguments must be an object"));
    }
    try {
      const serialized = JSON.stringify(inputArguments);
      if (serialized === undefined) {
        return Promise.reject(new TypeError("Input arguments are not JSON-serializable"));
      }
      parsed = JSON.parse(serialized);
    } catch (thrown) {
      return Promise.reject(thrown);
    }
  }
  if (callerSignal?.aborted) {
    return Promise.reject(callerSignal.reason);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return Promise.reject(
      new DOMException("Input arguments must be a JSON object", "UnknownError"),
    );
  }

  if (tool.inputSchema) {
    try {
      validateArgs(parsed as Record<string, unknown>, tool.inputSchema);
    } catch (thrown) {
      return Promise.reject(thrown);
    }
  }

  const controller = new AbortController();

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      controller.abort(); // default reason → generic AbortError, matching Chrome
      reject(callerSignal?.reason);
    };
    callerSignal?.addEventListener("abort", onAbort, { once: true });

    const onSettle = (result: unknown) => {
      if (settled) return; // late settlement after abort — ignored
      settled = true;
      callerSignal?.removeEventListener("abort", onAbort);
      try {
        resolve(serializeResult(result));
      } catch {
        reject(new DOMException("Tool result is not JSON-serializable", "UnknownError"));
      }
    };
    const onFail = (thrown: unknown) => {
      if (settled) return; // late rejection after abort — ignored
      settled = true;
      callerSignal?.removeEventListener("abort", onAbort);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      reject(new DOMException(`Tool execution failed: ${message}`, "UnknownError"));
    };

    // Invoke execute synchronously so its abort listener is attached before a
    // caller abort in the same turn; a sync throw joins the failure path.
    try {
      Promise.resolve(
        tool.execute(parsed as Record<string, unknown>, { signal: controller.signal }),
      ).then(onSettle, onFail);
    } catch (thrown) {
      onFail(thrown);
    }
  });
}
