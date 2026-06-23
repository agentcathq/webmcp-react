import type { RegisterToolOptions, ToolDescriptor } from "../types";
import { isPotentiallyTrustworthyOrigin, isValidToolName } from "./validation";

export interface RegistryInternal {
  registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): Promise<undefined>;
  getTools(): ReadonlyMap<string, ToolDescriptor>;
  addChangeListener(callback: () => void): () => void;
}

export function createRegistry(): RegistryInternal {
  const tools = new Map<string, ToolDescriptor>();
  const listeners = new Set<() => void>();
  let notificationPending = false;

  function scheduleNotification(): void {
    if (notificationPending) return;
    notificationPending = true;
    queueMicrotask(() => {
      notificationPending = false;
      for (const listener of listeners) listener();
    });
  }

  return {
    registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): Promise<undefined> {
      if (!isValidToolName(tool.name)) {
        return Promise.reject(
          new DOMException(
            "Tool name must be 1-128 characters of [A-Za-z0-9_.-]",
            "InvalidStateError",
          ),
        );
      }
      if (typeof tool.description !== "string" || tool.description === "") {
        return Promise.reject(
          new DOMException("Tool description must be a non-empty string", "InvalidStateError"),
        );
      }
      if (typeof tool.execute !== "function") {
        return Promise.reject(
          new DOMException("Tool execute must be a function", "InvalidStateError"),
        );
      }
      if (tools.has(tool.name)) {
        return Promise.reject(
          new DOMException(`Tool "${tool.name}" is already registered`, "InvalidStateError"),
        );
      }
      if (tool.inputSchema !== undefined) {
        // Only rejects hard-fail serialization (cycles, BigInt); lossy cases (functions, undefined) are not caught.
        try {
          JSON.stringify(tool.inputSchema);
        } catch {
          return Promise.reject(new TypeError("Tool inputSchema is not JSON-serializable"));
        }
      }
      if (options?.exposedTo) {
        for (const origin of options.exposedTo) {
          if (!isPotentiallyTrustworthyOrigin(origin)) {
            return Promise.reject(
              new DOMException(`exposedTo origin "${origin}" is not trustworthy`, "SecurityError"),
            );
          }
        }
      }
      if (options?.signal?.aborted) {
        // Native Chrome (verified 151) resolves without registering when handed an
        // already-aborted signal; match that rather than rejecting.
        return Promise.resolve(undefined);
      }

      tools.set(tool.name, {
        ...tool,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      });
      scheduleNotification();

      if (options?.signal) {
        const name = tool.name;
        const stored = tools.get(name);
        options.signal.addEventListener(
          "abort",
          () => {
            if (tools.get(name) === stored && tools.delete(name)) {
              scheduleNotification();
            }
          },
          { once: true },
        );
      }

      return Promise.resolve(undefined);
    },

    getTools(): ReadonlyMap<string, ToolDescriptor> {
      return tools;
    },

    addChangeListener(callback: () => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
