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

type TestingApi = NonNullable<typeof navigator.modelContextTesting>;

interface PageToolApi {
  /** The page object this adapter wraps, identity-compared to spot a swap. */
  readonly source: object;
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
    source: mc,
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
        // Future Chrome may take an object instead of a JSON string. A
        // TypeError here is argument conversion, so the tool never ran.
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
function createTestingApi(ctx: TestingApi): PageToolApi {
  return {
    source: ctx,
    list: () => Promise.resolve(ctx.listTools()),
    execute: (toolName, argsJson, signal) => ctx.executeTool(toolName, argsJson, { signal }),
    onChange: (callback) => ctx.registerToolsChangedCallback(callback),
  };
}

type DetectedSource =
  | { kind: "modelContext"; source: PageModelContext }
  | { kind: "testing"; source: TestingApi };

/** The page object the bridge should be talking to right now, if any. */
function detectSource(): DetectedSource | null {
  const mc = document.modelContext;
  if (mc && typeof mc.getTools === "function" && typeof mc.executeTool === "function") {
    return { kind: "modelContext", source: mc };
  }
  const mct = navigator.modelContextTesting;
  if (mct) return { kind: "testing", source: mct };
  return null;
}

function createApi(detected: DetectedSource): PageToolApi {
  return detected.kind === "modelContext"
    ? createModelContextApi(detected.source)
    : createTestingApi(detected.source);
}

let api: PageToolApi | null = null;
const pendingExecutions = new Map<string, AbortController>();

/**
 * Returns the adapter for the API the page currently exposes, rebuilding it
 * whenever that object was swapped out. webmcp-react installs a fresh
 * modelContext (and tool registry) whenever its provider remounts; native
 * Chrome keeps one object for the document's lifetime.
 */
function resolveApi(): PageToolApi | null {
  const detected = detectSource();
  if (!detected) {
    api = null;
    return null;
  }
  if (api && api.source === detected.source) return api;

  const next = createApi(detected);
  api = next;
  if (DEBUG) console.log(`[WebMCP Bridge] attached to page ${detected.kind} API`);
  // addEventListener dedupes the stable refreshTools reference on re-attach.
  next.onChange(refreshTools);
  next.list().then(sendToolsUpdate).catch(() => {});
  return next;
}

function refreshTools() {
  const previous = api;
  const current = resolveApi();
  // A rebuilt adapter has already pushed the new object's tool list.
  if (current && current === previous) {
    current.list().then(sendToolsUpdate).catch(() => {});
  }
}

function handleMessage(event: MessageEvent<PageMessage>) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "WEBMCP_EXECUTE_TOOL": {
      const current = resolveApi();
      if (!current) {
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
      current
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
    case "WEBMCP_CANCEL_TOOL": {
      pendingExecutions.get(data.requestId)?.abort();
      pendingExecutions.delete(data.requestId);
      break;
    }
    case "WEBMCP_REQUEST_TOOLS": {
      refreshTools();
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
// Once attached, keep re-resolving at a slower cadence so a polyfill swap is
// picked up even while the bridge sends no messages.
const WATCH_INTERVAL = 1_000;
let elapsed = 0;

function startWatch() {
  setInterval(resolveApi, WATCH_INTERVAL);
}

const pollTimer = setInterval(() => {
  elapsed += POLL_INTERVAL;

  if (resolveApi()) {
    clearInterval(pollTimer);
    if (DEBUG) console.log("[WebMCP Bridge] WebMCP API found");
    startWatch();
    return;
  }

  if (elapsed >= POLL_TIMEOUT) {
    clearInterval(pollTimer);
    if (DEBUG) console.log("[WebMCP Bridge] no WebMCP API found after 10s, watching");
    // A provider can still mount later, so keep watching.
    startWatch();
  }
}, POLL_INTERVAL);
