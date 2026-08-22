import type { PageMessage, RuntimeMessage } from "./types";

const DEBUG = false;

console.log("[WebMCP Bridge] content-isolated loaded");

// Forward page messages to background
window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "WEBMCP_TOOLS_UPDATED":
      chrome.runtime.sendMessage({
        type: "TOOLS_UPDATED",
        tools: data.tools,
      } satisfies RuntimeMessage);
      break;
    case "WEBMCP_TOOL_RESULT":
      chrome.runtime.sendMessage({
        type: "TOOL_RESULT",
        requestId: data.requestId,
        result: data.result,
        error: data.error,
      } satisfies RuntimeMessage);
      break;
  }
});

// Forward background messages to page
chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    switch (message.type) {
      case "EXECUTE_TOOL":
        window.postMessage(
          {
            type: "WEBMCP_EXECUTE_TOOL",
            requestId: message.requestId,
            toolName: message.toolName,
            argsJson: message.argsJson,
          } satisfies PageMessage,
          window.location.origin,
        );
        sendResponse({ ok: true });
        break;
      case "CANCEL_TOOL":
        window.postMessage(
          {
            type: "WEBMCP_CANCEL_TOOL",
            requestId: message.requestId,
          } satisfies PageMessage,
          window.location.origin,
        );
        sendResponse({ ok: true });
        break;
      case "REQUEST_TOOLS":
        window.postMessage(
          { type: "WEBMCP_REQUEST_TOOLS" } satisfies PageMessage,
          window.location.origin,
        );
        sendResponse({ ok: true });
        break;
    }
  },
);
