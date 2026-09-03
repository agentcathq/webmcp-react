import type { ModelContextTesting, ModelContextTestingExecuteToolOptions } from "../types";
import { warnOnce } from "../utils/warn";
import { runTool } from "./execute";
import type { RegistryInternal } from "./registry";

const DEPRECATION_KEY = "modelContextTesting-deprecated";
const DEPRECATION_MSG =
  "navigator.modelContextTesting is deprecated and will be removed in webmcp-react 2.0.0. " +
  "Use document.modelContext.getTools() / executeTool() instead.";

/** @deprecated Kept for one release as a wrapper over the modelContext consumer API. */
export function createTestingShim(registry: RegistryInternal): ModelContextTesting {
  let offChange: (() => void) | null = null;
  return {
    listTools() {
      warnOnce(DEPRECATION_KEY, DEPRECATION_MSG);
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
      warnOnce(DEPRECATION_KEY, DEPRECATION_MSG);
      const tool = registry.get(toolName);
      if (!tool) {
        throw new DOMException(`Tool "${toolName}" not found`, "NotFoundError");
      }

      // Keep this surface's historical input errors: OperationError, arrays rejected.
      let parsed: unknown;
      try {
        parsed = JSON.parse(inputArgsJson);
      } catch {
        throw new DOMException("Invalid JSON input", "OperationError");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new DOMException("Input must be a JSON object", "OperationError");
      }

      return runTool(tool, parsed as Record<string, unknown>, options?.signal);
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
