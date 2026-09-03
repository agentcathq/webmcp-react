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
 * Execute a registered tool the way native Chrome does (152–154 behavior):
 * JSON-string or object input, per-execution AbortSignal forwarded to the
 * tool, caller abort rejects with the caller signal's reason while the
 * tool-side signal aborts with a generic AbortError, late settlement after
 * abort is ignored, and results serialize to a string (objects via JSON,
 * primitives via String, empty string → "Operation succeeded").
 *
 * Deviation from native: input is validated against the tool's inputSchema
 * (OperationError) — Chrome does not validate yet (spec issue #92).
 */
export function runTool(
  tool: ToolDescriptor,
  inputArguments: string | object,
  callerSignal?: AbortSignal,
): Promise<string> {
  if (callerSignal?.aborted) {
    return Promise.reject(callerSignal.reason);
  }

  let parsed: unknown;
  if (typeof inputArguments === "string") {
    try {
      parsed = JSON.parse(inputArguments);
    } catch {
      return Promise.reject(new DOMException("Failed to parse input arguments", "UnknownError"));
    }
  } else {
    parsed = inputArguments;
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
