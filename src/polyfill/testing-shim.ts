import type {
  CallToolResult,
  MaybePromise,
  ModelContextTesting,
  ModelContextTestingExecuteToolOptions,
} from "../types";
import type { RegistryInternal } from "./registry";
import { validateArgs } from "./validation";

export function createTestingShim(registry: RegistryInternal): ModelContextTesting {
  let offChange: (() => void) | null = null;
  return {
    listTools() {
      return Array.from(registry.getTools().values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ? JSON.stringify(tool.inputSchema) : undefined,
      }));
    },

    async executeTool(
      toolName: string,
      inputArgsJson: string,
      options?: ModelContextTestingExecuteToolOptions,
    ): Promise<string | null> {
      const tool = registry.getTools().get(toolName);
      if (!tool) {
        throw new DOMException(`Tool "${toolName}" not found`, "NotFoundError");
      }

      if (options?.signal?.aborted) {
        throw new DOMException("Tool execution was aborted", "AbortError");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(inputArgsJson);
      } catch {
        throw new DOMException("Invalid JSON input", "OperationError");
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new DOMException("Input must be a JSON object", "OperationError");
      }

      if (tool.inputSchema) {
        validateArgs(parsed as Record<string, unknown>, tool.inputSchema);
      }

      const signal = options?.signal;
      let onAbort: (() => void) | undefined;
      let abortPromise: Promise<never> | undefined;
      if (signal) {
        const abort = { fire: () => {} };
        const raw = new Promise<never>((_, reject) => {
          abort.fire = () => reject(new DOMException("Tool execution was aborted", "AbortError"));
        });
        raw.catch(() => {});
        abortPromise = raw;
        onAbort = abort.fire;
        signal.addEventListener("abort", onAbort);
        if (signal.aborted) {
          onAbort();
        }
      }

      try {
        // This deprecated shim predates the two-argument execute(input, options)
        // signature and intentionally keeps calling with a single argument.
        const legacyExecute = tool.execute as (
          input: Record<string, unknown>,
        ) => MaybePromise<CallToolResult>;
        const resultPromise = Promise.resolve(legacyExecute(parsed as Record<string, unknown>));

        const result = abortPromise
          ? await Promise.race([abortPromise, resultPromise])
          : await resultPromise;

        return JSON.stringify(result);
      } finally {
        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },

    registerToolsChangedCallback(callback: () => void) {
      offChange?.();
      offChange = registry.addChangeListener(callback);
    },

    getCrossDocumentScriptToolResult() {
      return Promise.resolve("[]");
    },
  };
}
