import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { MISSING_PROVIDER, WebMCPContext } from "../context";
import type {
  CallToolResult,
  McpToolConfigJsonSchema,
  McpToolConfigZod,
  ToolDescriptor,
  ToolExecutionState,
  UseMcpToolReturn,
  ZodObjectSchema,
} from "../types";
import {
  isZodObjectSchema,
  parseZodInput,
  schemaFingerprint,
  zodToInputSchema,
} from "../utils/schema";
import { warnOnce } from "../utils/warn";

const TOOL_OWNER_BY_NAME = new Map<string, symbol>();

// test-only
export function _resetToolOwners(): void {
  TOOL_OWNER_BY_NAME.clear();
}

// Normalize a thrown value into an Error while preserving its `name`.
// registerTool rejects with DOMException, which is not `instanceof Error` in
// every environment (e.g. jsdom); a naive `new Error(String(thrown))` would
// drop the `name` (e.g. "InvalidStateError", "AbortError") that callers route on.
function normalizeError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "name" in thrown &&
    typeof (thrown as { name: unknown }).name === "string"
  ) {
    const source = thrown as { name: string; message?: unknown };
    const error = new Error(typeof source.message === "string" ? source.message : String(thrown));
    error.name = source.name;
    return error;
  }
  return new Error(String(thrown));
}

const INITIAL_STATE: ToolExecutionState = {
  isExecuting: false,
  lastResult: null,
  error: null,
  executionCount: 0,
};

export function useMcpTool<T extends ZodObjectSchema>(
  config: McpToolConfigZod<T>,
): UseMcpToolReturn;

export function useMcpTool(config: McpToolConfigJsonSchema): UseMcpToolReturn;

export function useMcpTool(config: McpToolConfigZod | McpToolConfigJsonSchema): UseMcpToolReturn {
  const ctx = useContext(WebMCPContext);
  if (ctx === MISSING_PROVIDER) {
    warnOnce(
      "useMcpTool-missing-provider",
      "useMcpTool is being used outside <WebMCPProvider>. The tool may not be registered if no polyfill or native API is present.",
    );
  }

  const isZodPath = "input" in config && isZodObjectSchema(config.input);

  const inputFingerprint = schemaFingerprint(
    isZodPath
      ? (config as McpToolConfigZod).input
      : (config as McpToolConfigJsonSchema).inputSchema,
  );
  const outputFingerprint = schemaFingerprint(
    isZodPath
      ? (config as McpToolConfigZod).output
      : (config as McpToolConfigJsonSchema).outputSchema,
  );
  const annotationsFingerprint = config.annotations ? JSON.stringify(config.annotations) : "";
  const titleFingerprint = config.title ?? "";
  const exposedToFingerprint = config.exposedTo ? JSON.stringify(config.exposedTo) : "";

  const [state, setState] = useState<ToolExecutionState>(INITIAL_STATE);

  const configRef = useRef(config);
  const handlerRef = useRef(config.handler);
  const onSuccessRef = useRef(config.onSuccess);
  const onErrorRef = useRef(config.onError);
  const isMountedRef = useRef(true);
  const inFlightCountRef = useRef(0);

  configRef.current = config;
  handlerRef.current = config.handler;
  onSuccessRef.current = config.onSuccess;
  onErrorRef.current = config.onError;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const execute = useCallback(async (input?: Record<string, unknown>): Promise<CallToolResult> => {
    inFlightCountRef.current++;
    setState((prev) => ({ ...prev, isExecuting: true, error: null }));

    try {
      let validatedInput: Record<string, unknown> = input ?? {};
      const currentConfig = configRef.current;
      const currentIsZod = "input" in currentConfig && isZodObjectSchema(currentConfig.input);

      if (currentIsZod) {
        validatedInput = parseZodInput((currentConfig as McpToolConfigZod).input, validatedInput);
      }

      const result = await handlerRef.current(validatedInput as Record<string, unknown>, {
        signal: new AbortController().signal,
      });

      if (isMountedRef.current) {
        inFlightCountRef.current--;
        setState((prev) => ({
          isExecuting: inFlightCountRef.current > 0,
          lastResult: result,
          error: null,
          executionCount: prev.executionCount + 1,
        }));
      } else {
        inFlightCountRef.current--;
      }

      onSuccessRef.current?.(result);
      return result;
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));

      if (isMountedRef.current) {
        inFlightCountRef.current--;
        setState((prev) => ({
          ...prev,
          isExecuting: inFlightCountRef.current > 0,
          error,
        }));
      } else {
        inFlightCountRef.current--;
      }

      onErrorRef.current?.(error);
      throw error;
    }
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: schema objects are tracked via fingerprints, handler/callbacks via refs
  useEffect(() => {
    if (typeof document === "undefined" || !document.modelContext) {
      return;
    }

    const mc = document.modelContext;
    const cfg = configRef.current;
    const ownerToken = Symbol(cfg.name);
    const zodPath = "input" in cfg && isZodObjectSchema(cfg.input);

    // Compute resolved schemas inside effect body to avoid per-render allocation
    const resolvedInputSchema = zodPath
      ? zodToInputSchema((cfg as McpToolConfigZod).input)
      : (cfg as McpToolConfigJsonSchema).inputSchema;

    const zodOutput = zodPath ? (cfg as McpToolConfigZod).output : undefined;
    const resolvedOutputSchema = zodPath
      ? zodOutput
        ? zodToInputSchema(zodOutput)
        : undefined
      : (cfg as McpToolConfigJsonSchema).outputSchema;

    const descriptor: ToolDescriptor = {
      name: cfg.name,
      ...(cfg.title && { title: cfg.title }),
      description: cfg.description,
      ...(resolvedInputSchema && { inputSchema: resolvedInputSchema }),
      ...(resolvedOutputSchema && { outputSchema: resolvedOutputSchema }),
      ...(cfg.annotations && { annotations: cfg.annotations }),
      execute: async (args: Record<string, unknown>): Promise<CallToolResult> => {
        inFlightCountRef.current++;
        if (isMountedRef.current) {
          setState((prev) => ({ ...prev, isExecuting: true, error: null }));
        }

        try {
          let validatedArgs = args;
          const currentConfig = configRef.current;
          const currentIsZod = "input" in currentConfig && isZodObjectSchema(currentConfig.input);

          if (currentIsZod) {
            validatedArgs = parseZodInput((currentConfig as McpToolConfigZod).input, args);
          }

          const result = await handlerRef.current(validatedArgs as Record<string, unknown>, {
            signal: new AbortController().signal,
          });

          if (isMountedRef.current) {
            inFlightCountRef.current--;
            setState((prev) => ({
              isExecuting: inFlightCountRef.current > 0,
              lastResult: result,
              error: null,
              executionCount: prev.executionCount + 1,
            }));
          } else {
            inFlightCountRef.current--;
          }

          onSuccessRef.current?.(result);
          return result;
        } catch (thrown) {
          const error = thrown instanceof Error ? thrown : new Error(String(thrown));

          if (isMountedRef.current) {
            inFlightCountRef.current--;
            setState((prev) => ({
              ...prev,
              isExecuting: inFlightCountRef.current > 0,
              error,
            }));
          } else {
            inFlightCountRef.current--;
          }

          onErrorRef.current?.(error);

          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
      },
    };

    const controller = new AbortController();
    const alreadyOwned = TOOL_OWNER_BY_NAME.has(cfg.name);
    if (!alreadyOwned) {
      TOOL_OWNER_BY_NAME.set(cfg.name, ownerToken);
    }

    const handleRegistrationError = (thrown: unknown) => {
      const error = normalizeError(thrown);
      if (error.name === "AbortError") return; // lifecycle teardown — not a user error
      if (TOOL_OWNER_BY_NAME.get(cfg.name) === ownerToken) {
        TOOL_OWNER_BY_NAME.delete(cfg.name);
      }
      if (isMountedRef.current) {
        setState((prev) => ({ ...prev, error }));
      }
      onErrorRef.current?.(error);
    };

    try {
      // Native Chrome <=151 returns undefined and throws synchronously on error;
      // the spec, native Chrome 152+, and our polyfill return a Promise<undefined>
      // that rejects. Handle both shapes.
      const result: unknown = mc.registerTool(descriptor, {
        signal: controller.signal,
        ...(cfg.exposedTo && { exposedTo: cfg.exposedTo }),
      });
      if (result && typeof (result as { then?: unknown }).then === "function") {
        (result as Promise<unknown>).catch(handleRegistrationError);
      }
    } catch (thrown) {
      handleRegistrationError(thrown);
    }

    return () => {
      if (TOOL_OWNER_BY_NAME.get(cfg.name) !== ownerToken) {
        return;
      }
      TOOL_OWNER_BY_NAME.delete(cfg.name);
      controller.abort();
    };
  }, [
    ctx.available,
    config.name,
    config.description,
    inputFingerprint,
    outputFingerprint,
    annotationsFingerprint,
    titleFingerprint,
    exposedToFingerprint,
  ]);

  return { state, execute, reset };
}
