import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { MISSING_PROVIDER, WebMCPContext } from "../context";
import type {
  CallToolResult,
  McpToolConfigJsonSchema,
  McpToolConfigZod,
  ModelContextClient,
  ToolDescriptor,
  ToolExecutionState,
  UseMcpToolReturn,
} from "../types";
import { schemaFingerprint, zodToInputSchema } from "../utils/schema";
import { warnOnce } from "../utils/warn";

const TOOL_OWNER_BY_NAME = new Map<string, symbol>();

// test-only
export function _resetToolOwners(): void {
  TOOL_OWNER_BY_NAME.clear();
}

const INITIAL_STATE: ToolExecutionState = {
  isExecuting: false,
  lastResult: null,
  error: null,
  executionCount: 0,
};

export function useMcpTool<T extends z.ZodRawShape>(config: McpToolConfigZod<T>): UseMcpToolReturn;

export function useMcpTool(config: McpToolConfigJsonSchema): UseMcpToolReturn;

export function useMcpTool(
  config: McpToolConfigZod<z.ZodRawShape> | McpToolConfigJsonSchema,
): UseMcpToolReturn {
  const ctx = useContext(WebMCPContext);
  if (ctx === MISSING_PROVIDER) {
    warnOnce(
      "useMcpTool-missing-provider",
      "useMcpTool is being used outside <WebMCPProvider>. The tool may not be registered if no polyfill or native API is present.",
    );
  }

  const isZodPath = "input" in config && config.input instanceof z.ZodObject;

  const inputFingerprint = schemaFingerprint(
    isZodPath
      ? (config as McpToolConfigZod<z.ZodRawShape>).input
      : (config as McpToolConfigJsonSchema).inputSchema,
  );
  const outputFingerprint = schemaFingerprint(
    isZodPath
      ? (config as McpToolConfigZod<z.ZodRawShape>).output
      : (config as McpToolConfigJsonSchema).outputSchema,
  );
  const annotationsFingerprint = config.annotations ? JSON.stringify(config.annotations) : "";

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
      const currentIsZod = "input" in currentConfig && currentConfig.input instanceof z.ZodObject;

      if (currentIsZod) {
        validatedInput = (currentConfig as McpToolConfigZod<z.ZodRawShape>).input.parse(
          validatedInput,
        );
      }

      const client: ModelContextClient = {
        requestUserInteraction: (callback) => callback(),
      };

      const result = await handlerRef.current(validatedInput as Record<string, unknown>, client);

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
    const zodPath = "input" in cfg && cfg.input instanceof z.ZodObject;

    // Compute resolved schemas inside effect body to avoid per-render allocation
    const resolvedInputSchema = zodPath
      ? zodToInputSchema((cfg as McpToolConfigZod<z.ZodRawShape>).input)
      : (cfg as McpToolConfigJsonSchema).inputSchema;

    const zodOutput = zodPath ? (cfg as McpToolConfigZod<z.ZodRawShape>).output : undefined;
    const resolvedOutputSchema = zodPath
      ? zodOutput
        ? zodToInputSchema(zodOutput)
        : undefined
      : (cfg as McpToolConfigJsonSchema).outputSchema;

    const descriptor: ToolDescriptor = {
      name: cfg.name,
      description: cfg.description,
      ...(resolvedInputSchema && { inputSchema: resolvedInputSchema }),
      ...(resolvedOutputSchema && { outputSchema: resolvedOutputSchema }),
      ...(cfg.annotations && { annotations: cfg.annotations }),
      execute: async (
        args: Record<string, unknown>,
        client: ModelContextClient,
      ): Promise<CallToolResult> => {
        inFlightCountRef.current++;
        if (isMountedRef.current) {
          setState((prev) => ({ ...prev, isExecuting: true, error: null }));
        }

        try {
          let validatedArgs = args;
          const currentConfig = configRef.current;
          const currentIsZod =
            "input" in currentConfig && currentConfig.input instanceof z.ZodObject;

          if (currentIsZod) {
            validatedArgs = (currentConfig as McpToolConfigZod<z.ZodRawShape>).input.parse(args);
          }

          const result = await handlerRef.current(validatedArgs as Record<string, unknown>, client);

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

    mc.registerTool(descriptor, { signal: controller.signal }).catch((err) => {
      warnOnce(
        `register-${cfg.name}`,
        `Failed to register tool "${cfg.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    TOOL_OWNER_BY_NAME.set(cfg.name, ownerToken);

    return () => {
      const currentOwner = TOOL_OWNER_BY_NAME.get(cfg.name);
      if (currentOwner !== ownerToken) {
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
  ]);

  return { state, execute, reset };
}
