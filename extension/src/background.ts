import type {
  BrowserTool,
  RuntimeMessage,
  WsMessageFromServer,
  WsToolsListResponse,
  WsToolResultResponse,
  WsToolsChangedNotification,
} from "./types";

const DEBUG = false;

console.log("[WebMCP Bridge] background loaded");

const tabTools = new Map<
  number,
  { tools: BrowserTool[]; title: string; url: string }
>();

const pendingCalls = new Map<string, number>();

// Activation state
const activatedTabs = new Set<number>();
const activatedDomains = new Set<string>();

let ws: WebSocket | null = null;
let wsConnected = false;
let reconnectDelay = 1000;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
const MAX_RECONNECT_DELAY = 30_000;
const WS_PORT = 12315;
const STORAGE_KEY = "activatedDomains";

function sanitize(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function parseInputSchema(schema?: string): object | undefined {
  if (!schema) return undefined;
  try {
    return JSON.parse(schema) as object;
  } catch {
    return undefined;
  }
}

// Simple hash for use in content script registration IDs
function originHash(origin: string): string {
  let hash = 0;
  for (let i = 0; i < origin.length; i++) {
    hash = ((hash << 5) - hash + origin.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Whether two urls address the same document, i.e. differ only by fragment. */
function isSameDocument(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = "";
    ub.hash = "";
    return ua.href === ub.href;
  } catch {
    return false;
  }
}

function buildAggregatedTools(): WsToolsListResponse["tools"] {
  const tools: WsToolsListResponse["tools"] = [];
  for (const [tabId, info] of tabTools) {
    const title = sanitize(info.title, 500);
    const url = sanitize(info.url, 500);
    for (const tool of info.tools) {
      tools.push({
        name: `tab-${tabId}:${tool.name}`,
        description: `[${title}: ${hostnameFromUrl(url)}] ${tool.description}`,
        inputSchema: parseInputSchema(tool.inputSchema),
        tabId,
        tabTitle: title,
        tabUrl: url,
      });
    }
  }
  return tools;
}

function wsSend(data: WsToolsListResponse | WsToolResultResponse | WsToolsChangedNotification) {
  if (ws && wsConnected) {
    ws.send(JSON.stringify(data));
  }
}

// --- Badge ---

function hasActiveState(): boolean {
  return activatedTabs.size > 0 || activatedDomains.size > 0;
}

function updateBadge() {
  const totalTools = Array.from(tabTools.values()).reduce(
    (sum, info) => sum + info.tools.length,
    0,
  );
  if (!wsConnected && hasActiveState()) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
  } else if (totalTools > 0) {
    chrome.action.setBadgeText({ text: String(totalTools) });
    chrome.action.setBadgeBackgroundColor({ color: "#34a853" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function notifyToolsChanged() {
  wsSend({ type: "TOOLS_CHANGED" });

  updateBadge();
}

function rejectPendingCallsForTab(tabId: number) {
  for (const [requestId, callTabId] of pendingCalls) {
    if (callTabId === tabId) {
      pendingCalls.delete(requestId);
      wsSend({
        type: "TOOL_RESULT",
        requestId,
        result: null,
        error: "Tab closed or navigated away",
      });
    }
  }
}

// --- Activation helpers ---

async function persistDomains() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: Array.from(activatedDomains),
  });
}

// Resolves once the persisted activations are in memory. A service worker
// restart re-runs this file, and a content script can report its tools before
// storage has been read, so handlers that decide on activation wait for this.
async function hasHostPermission(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function loadPersistedDomains() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored: string[] = data[STORAGE_KEY] ?? [];

  // Host permissions are optional and are not guaranteed to outlive the
  // activation stored here: reinstalling the extension keeps its storage and
  // drops its granted origins. Content scripts cannot be registered for an
  // origin we no longer hold, so keeping it would leave the popup reporting a
  // domain as active while nothing on it can be reached.
  const granted: string[] = [];
  for (const origin of stored) {
    if (await hasHostPermission(origin)) granted.push(origin);
  }

  for (const d of granted) {
    activatedDomains.add(d);
  }

  if (granted.length !== stored.length) {
    await persistDomains();
  }

  if (granted.length > 0) {
    await registerContentScriptsForDomains(granted);
  }
}

// Resolves once the persisted activations are in memory. A service worker
// restart re-runs this file, and a content script can report its tools before
// storage has been read, so handlers that decide on activation wait for this.
const domainsReady: Promise<void> = loadPersistedDomains();

async function registerContentScriptsForDomains(origins: string[]) {
  const scripts: chrome.scripting.RegisteredContentScript[] = [];
  for (const origin of origins) {
    const h = originHash(origin);
    scripts.push(
      {
        id: `webmcp-main-${h}`,
        matches: [`${origin}/*`],
        js: ["content-main.js"],
        world: "MAIN" as chrome.scripting.ExecutionWorld,
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
      {
        id: `webmcp-isolated-${h}`,
        matches: [`${origin}/*`],
        js: ["content-isolated.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    );
  }
  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch (err) {
    // Scripts may already be registered from a previous session
    console.warn("[WebMCP Bridge] registerContentScripts:", err);
  }
}

async function unregisterContentScriptsForDomain(origin: string) {
  const h = originHash(origin);
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [`webmcp-main-${h}`, `webmcp-isolated-${h}`],
    });
  } catch {
    // Already unregistered
  }
}

async function injectContentScripts(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-isolated.js"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-main.js"],
    world: "MAIN" as chrome.scripting.ExecutionWorld,
  });
}

function purgeTabTools(tabId: number) {
  if (tabTools.has(tabId)) {
    tabTools.delete(tabId);
    rejectPendingCallsForTab(tabId);
    notifyToolsChanged();
  }
}

function isTabAuthorized(tabId: number, tabUrl?: string): boolean {
  if (activatedTabs.has(tabId)) return true;
  if (tabUrl) {
    const origin = originFromUrl(tabUrl);
    if (origin && activatedDomains.has(origin)) return true;
  }
  return false;
}

function getTabActivation(tabId: number, tabUrl?: string): "off" | "tab" | "domain" {
  if (tabUrl) {
    const origin = originFromUrl(tabUrl);
    if (origin && activatedDomains.has(origin)) return "domain";
  }
  if (activatedTabs.has(tabId)) return "tab";
  return "off";
}

// --- WebSocket ---

function connectWebSocket() {
  try {
    ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    if (DEBUG) console.log("[WebMCP Bridge] Connected to MCP server");
    wsConnected = true;
    reconnectDelay = 1000;

    keepAliveInterval = setInterval(() => {
      if (ws && wsConnected) {
        ws.send(JSON.stringify({ type: "PING" }));
      }
    }, 20_000);

  
    updateBadge();
    notifyToolsChanged();
  };

  ws.onmessage = (event) => {
    const raw = String(event.data);
    if (DEBUG) console.log("[WebMCP Bridge] ws.onmessage raw:", raw.slice(0, 300));
    try {
      const data = JSON.parse(raw) as WsMessageFromServer;
      handleServerMessage(data);
    } catch (err) {
      console.error("[WebMCP Bridge] Failed to parse server message:", err);
    }
  };

  ws.onclose = () => {
    if (DEBUG) console.log("[WebMCP Bridge] Disconnected from MCP server");
    wsConnected = false;
    ws = null;
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
  
    updateBadge();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this. reconnect handled there
  };
}

function scheduleReconnect() {
  setTimeout(() => {
    connectWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function handleServerMessage(data: WsMessageFromServer) {
  if (DEBUG) console.log("[WebMCP Bridge] ← server message:", data.type, data);
  switch (data.type) {
    case "LIST_TOOLS": {
      const tools = buildAggregatedTools();
      if (DEBUG) console.log("[WebMCP Bridge] → TOOLS_LIST with", tools.length, "tools");
      wsSend({
        type: "TOOLS_LIST",
        requestId: data.requestId,
        tools,
      });
      break;
    }
    case "CALL_TOOL": {
      const { requestId, tabId, toolName, argsJson } = data;
      if (DEBUG) console.log("[WebMCP Bridge] CALL_TOOL:", { tabId, toolName, argsJson: argsJson.slice(0, 200) });

      if (!tabTools.has(tabId)) {
        console.warn("[WebMCP Bridge] Tab not found in tabTools. Known tabs:", [...tabTools.keys()]);
        wsSend({
          type: "TOOL_RESULT",
          requestId,
          result: null,
          error: `Tab ${tabId} not found`,
        });
        break;
      }

      const tabInfo = tabTools.get(tabId)!;
      if (DEBUG) console.log("[WebMCP Bridge] Tab info:", { title: tabInfo.title, url: tabInfo.url, toolCount: tabInfo.tools.length });
      if (DEBUG) console.log("[WebMCP Bridge] Auth check:", { isAuthorized: isTabAuthorized(tabId, tabInfo.url), activatedTabs: [...activatedTabs], activatedDomains: [...activatedDomains] });

      if (!isTabAuthorized(tabId, tabInfo.url)) {
        console.warn("[WebMCP Bridge] Tab not authorized, purging");
        purgeTabTools(tabId);
        wsSend({
          type: "TOOL_RESULT",
          requestId,
          result: null,
          error: `Tab ${tabId} is not authorized`,
        });
        break;
      }

      pendingCalls.set(requestId, tabId);
      if (DEBUG) console.log("[WebMCP Bridge] Sending EXECUTE_TOOL to tab", tabId);

      chrome.tabs.sendMessage(
        tabId,
        {
          type: "EXECUTE_TOOL",
          requestId,
          toolName,
          argsJson,
        } satisfies RuntimeMessage,
        () => {
          if (chrome.runtime.lastError) {
            console.error("[WebMCP Bridge] sendMessage failed:", chrome.runtime.lastError.message);
            pendingCalls.delete(requestId);
            wsSend({
              type: "TOOL_RESULT",
              requestId,
              result: null,
              error: `Failed to reach tab ${tabId}: ${chrome.runtime.lastError.message}`,
            });
          } else {
            if (DEBUG) console.log("[WebMCP Bridge] sendMessage delivered to tab", tabId);
          }
        },
      );
      break;
    }
    case "CANCEL_TOOL": {
      const { requestId } = data;
      const tabId = pendingCalls.get(requestId);
      if (tabId === undefined) break;
      // Drop the pending entry so the late error TOOL_RESULT from the page is ignored.
      pendingCalls.delete(requestId);
      if (DEBUG) console.log("[WebMCP Bridge] CANCEL_TOOL for tab", tabId, requestId);
      chrome.tabs.sendMessage(
        tabId,
        { type: "CANCEL_TOOL", requestId } satisfies RuntimeMessage,
        () => {
          // Touch lastError so a closed tab doesn't log an unchecked-error warning.
          void chrome.runtime.lastError;
        },
      );
      break;
    }
  }
}

// --- Runtime message handler ---

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender, sendResponse) => {
    if (DEBUG) console.log("[WebMCP Bridge] runtime.onMessage:", message.type, "from tab", sender.tab?.id, message);
    switch (message.type) {
      case "TOOLS_UPDATED": {
        const tabId = sender.tab?.id;
        if (tabId == null) break;
        const { tools } = message;
        const url = sender.tab?.url;
        const title = sender.tab?.title;
        // An activated domain reads as unauthorized until storage has been
        // read, and this branch purges rather than defers, so a page that
        // registers during that window loses its tools until it registers
        // again. Decide once the activations are in memory.
        void domainsReady.then(() => {
          if (!isTabAuthorized(tabId, url)) {
            // Stale content script from a deactivated tab — purge and ignore
            purgeTabTools(tabId);
            return;
          }
          tabTools.set(tabId, {
            tools,
            title: sanitize(title ?? "", 500),
            url: sanitize(url ?? "", 500),
          });
          notifyToolsChanged();
        });
        break;
      }
      case "TOOL_RESULT": {
        const { requestId, result, error } = message;
        if (!pendingCalls.has(requestId)) break;
        const senderTabId = sender.tab?.id;
        if (senderTabId != null && !isTabAuthorized(senderTabId, sender.tab?.url)) {
          // Stale content script — drop the result
          pendingCalls.delete(requestId);
          break;
        }
        pendingCalls.delete(requestId);

        wsSend({
          type: "TOOL_RESULT",
          requestId,
          result,
          error,
        });
        break;
      }
      case "ACTIVATE_TAB": {
        const { tabId } = message;
        if (activatedTabs.has(tabId)) {
          sendResponse({ ok: true });
          return true;
        }
        activatedTabs.add(tabId);
      
        injectContentScripts(tabId).then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: String(err) }),
        );
        return true; // async response
      }
      case "ACTIVATE_DOMAIN": {
        const { tabId, origin } = message;
        activatedDomains.add(origin);
      
        Promise.all([
          persistDomains(),
          registerContentScriptsForDomains([origin]),
          // Also inject into current tab immediately
          activatedTabs.has(tabId)
            ? Promise.resolve()
            : injectContentScripts(tabId),
        ]).then(
          () => {
            activatedTabs.add(tabId);
            sendResponse({ ok: true });
          },
          (err) => sendResponse({ ok: false, error: String(err) }),
        );
        return true;
      }
      case "DEACTIVATE_TAB": {
        const { tabId } = message;
        activatedTabs.delete(tabId);
        // Only purge if not still authorized via domain
        if (!isTabAuthorized(tabId, tabTools.get(tabId)?.url)) {
          purgeTabTools(tabId);
        }
      
        updateBadge();
        sendResponse({ ok: true });
        return true;
      }
      case "DEACTIVATE_DOMAIN": {
        const { origin } = message;
        activatedDomains.delete(origin);
      

        // Purge tools from tabs on this origin — but only if not still authorized via activatedTabs
        for (const [tabId, info] of tabTools) {
          if (originFromUrl(info.url) === origin && !activatedTabs.has(tabId)) {
            purgeTabTools(tabId);
          }
        }

        Promise.all([
          persistDomains(),
          unregisterContentScriptsForDomain(origin),
          chrome.permissions.remove({ origins: [`${origin}/*`] }),
        ]).then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: String(err) }),
        );
        return true;
      }
      case "GET_STATUS": {
        const queryTabId = message.tabId;
        // Look up the tab URL for activation status
        const getActivation = async (): Promise<"off" | "tab" | "domain"> => {
          if (queryTabId == null) return "off";
          try {
            const tab = await chrome.tabs.get(queryTabId);
            return getTabActivation(queryTabId, tab.url);
          } catch {
            return "off";
          }
        };

        getActivation().then((currentTabActivation) => {
          const tabs = Array.from(tabTools.entries()).map(([tabId, info]) => ({
            tabId,
            title: info.title,
            url: info.url,
            toolCount: info.tools.length,
            toolNames: info.tools.map((t) => t.name),
          }));
          sendResponse({
            type: "STATUS",
            tabs,
            mcpServerConnected: wsConnected,
            activatedTabs: Array.from(activatedTabs),
            activatedDomains: Array.from(activatedDomains),
            currentTabActivation,
          } satisfies RuntimeMessage);
        });
        return true;
      }
    }
  },
);

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  activatedTabs.delete(tabId);
  if (tabTools.has(tabId)) {
    tabTools.delete(tabId);
    rejectPendingCallsForTab(tabId);
    notifyToolsChanged();
  }
});

// Clean up when tabs navigate
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;

  // A fragment change is a same-document navigation, which routers use for
  // every in-app route: the document keeps the tools it registered and content
  // scripts do not run again, so there would be nothing left to report them.
  const known = tabTools.get(tabId);
  if (known && changeInfo.url && isSameDocument(known.url, changeInfo.url)) {
    if (DEBUG) console.log("[WebMCP Bridge] same-document navigation, keeping tools", changeInfo.url);
    return;
  }

  // Session-only activation doesn't survive navigation
  activatedTabs.delete(tabId);
  if (tabTools.has(tabId)) {
    tabTools.delete(tabId);
    rejectPendingCallsForTab(tabId);
    notifyToolsChanged();
  }
});

// Start the WebSocket; the persisted activations are already loading
connectWebSocket();
