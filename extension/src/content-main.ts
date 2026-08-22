import type { BrowserTool, PageMessage, PageModelContext, PageRegisteredTool } from "./types";

const DEBUG = false;

console.log("[WebMCP Bridge] content-main loaded");

function postToIsolated(message: PageMessage) {
  window.postMessage(message, window.location.origin);
}

function sendToolsUpdate(tools: BrowserTool[]) {
  postToIsolated({ type: "WEBMCP_TOOLS_UPDATED", tools });
}

function schemaToString(schema: string | object | undefined): string | undefined {
  if (schema === undefined || schema === null) return undefined;
  return typeof schema === "string" ? schema : JSON.stringify(schema);
}

interface PageToolApi {
  list(): Promise<BrowserTool[]>;
  execute(toolName: string, argsJson: string, signal: AbortSignal): Promise<string | null>;
  onChange(callback: () => void): void;
}

// Native Chrome / webmcp-react 1.1.0+ polyfill: the standard consumer API.
function createModelContextApi(mc: PageModelContext): PageToolApi {
  const getTools = mc.getTools?.bind(mc);
  const executeTool = mc.executeTool?.bind(mc);
  if (!getTools || !executeTool) throw new Error("modelContext consumer API unavailable");
  return {
    async list() {
      const tools = await getTools();
      return tools.map((t: PageRegisteredTool) => ({
        name: t.name,
        description: t.description,
        inputSchema: schemaToString(t.inputSchema),
      }));
    },
    async execute(toolName, argsJson, signal) {
      const tools = await getTools();
      const tool = tools.find((t: PageRegisteredTool) => t.name === toolName);
      if (!tool) throw new Error(`Tool "${toolName}" not found`);
      try {
        return await executeTool(tool, argsJson, { signal });
      } catch (err) {
        // Future Chrome may require an object instead of a JSON string.
        if (err instanceof TypeError) {
          return await executeTool(tool, JSON.parse(argsJson) as object, { signal });
        }
        throw err;
      }
    },
    onChange(callback) {
      mc.addEventListener("toolchange", callback);
    },
  };
}

// Fallback for pages on webmcp-react <=1.0.0 / Chrome <=151.
function createTestingApi(ctx: NonNullable<typeof navigator.modelContextTesting>): PageToolApi {
  return {
    list: () => Promise.resolve(ctx.listTools()),
    execute: (toolName, argsJson, signal) => ctx.executeTool(toolName, argsJson, { signal }),
    onChange: (callback) => ctx.registerToolsChangedCallback(callback),
  };
}

function detectApi(): PageToolApi | null {
  const mc = document.modelContext;
  if (mc && typeof mc.getTools === "function" && typeof mc.executeTool === "function") {
    return createModelContextApi(mc);
  }
  const mct = navigator.modelContextTesting;
  if (mct) return createTestingApi(mct);
  return null;
}

let api: PageToolApi | null = null;
const pendingExecutions = new Map<string, AbortController>();

function handleMessage(event: MessageEvent<PageMessage>) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "WEBMCP_EXECUTE_TOOL": {
      if (!api) {
        postToIsolated({
          type: "WEBMCP_TOOL_RESULT",
          requestId: data.requestId,
          result: null,
          error: "WebMCP API not available",
        });
        break;
      }
      const controller = new AbortController();
      pendingExecutions.set(data.requestId, controller);
      api
        .execute(data.toolName, data.argsJson, controller.signal)
        .then((result: string | null) => {
          postToIsolated({ type: "WEBMCP_TOOL_RESULT", requestId: data.requestId, result });
        })
        .catch((err: unknown) => {
          postToIsolated({
            type: "WEBMCP_TOOL_RESULT",
            requestId: data.requestId,
            result: null,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          pendingExecutions.delete(data.requestId);
        });
      break;
    }
    case "WEBMCP_REQUEST_TOOLS": {
      if (api) {
        api.list().then(sendToolsUpdate).catch(() => {});
      }
      break;
    }
  }
}

window.addEventListener("message", handleMessage);

// Poll for a WebMCP API: native modelContext, the 1.1.0 polyfill, or the
// legacy testing shim (<=1.0.0 pages). The polyfill installs on provider mount,
// so the API may appear well after document load.
const POLL_INTERVAL = 100;
const POLL_TIMEOUT = 10_000;
let elapsed = 0;

const pollTimer = setInterval(() => {
  elapsed += POLL_INTERVAL;
  const found = detectApi();

  if (found) {
    clearInterval(pollTimer);
    api = found;
    if (DEBUG) console.log("[WebMCP Bridge] WebMCP API found");
    api.list().then(sendToolsUpdate).catch(() => {});
    api.onChange(() => {
      api?.list().then(sendToolsUpdate).catch(() => {});
    });
    return;
  }

  if (elapsed >= POLL_TIMEOUT) {
    clearInterval(pollTimer);
    if (DEBUG) console.log("[WebMCP Bridge] no WebMCP API found after 10s, giving up");
  }
}, POLL_INTERVAL);
