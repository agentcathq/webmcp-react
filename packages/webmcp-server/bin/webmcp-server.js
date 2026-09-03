#!/usr/bin/env node

// src/mcp-server/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

// src/mcp-server/tool-registry.ts
var CALL_TIMEOUT = 3e4;
var NAMESPACED_RE = /^tab-(\d+):(.+)$/;
var ToolRegistry = class {
  constructor() {
    this.tools = /* @__PURE__ */ new Map();
    this.changeCallbacks = [];
    this.pendingCalls = /* @__PURE__ */ new Map();
    this.ws = null;
  }
  setWebSocket(ws) {
    this.ws = ws;
  }
  updateTools(tools) {
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.namespacedName, tool);
    }
    this.fireChangeCallbacks();
  }
  listMcpTools() {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.namespacedName,
      description: `[${t.tabTitle}] ${t.description}`,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} }
    }));
  }
  async callTool(name, args, signal) {
    const match = NAMESPACED_RE.exec(name);
    if (!match) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid tool name format: "${name}". Expected "tab-{id}:{name}".`
          }
        ]
      };
    }
    const tabId = Number(match[1]);
    const toolName = match[2];
    if (!this.tools.has(name)) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Tool "${name}" not found.` }
        ]
      };
    }
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return {
        isError: true,
        content: [
          { type: "text", text: "Extension not connected." }
        ]
      };
    }
    if (signal?.aborted) {
      const err = new Error("Tool call aborted by client");
      err.name = "AbortError";
      throw err;
    }
    const requestId = crypto.randomUUID();
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pendingCalls.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingCalls.delete(requestId);
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({ type: "CANCEL_TOOL", requestId })
          );
        }
        const err = new Error("Tool call aborted by client");
        err.name = "AbortError";
        reject(err);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.pendingCalls.delete(requestId);
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({ type: "CANCEL_TOOL", requestId })
          );
        }
        resolve({
          isError: true,
          content: [{ type: "text", text: `Tool call "${name}" timed out after ${CALL_TIMEOUT}ms` }]
        });
      }, CALL_TIMEOUT);
      this.pendingCalls.set(requestId, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort)
      });
      const message = {
        type: "CALL_TOOL",
        requestId,
        tabId,
        toolName,
        argsJson: JSON.stringify(args)
      };
      ws.send(JSON.stringify(message));
    });
  }
  handleMessage(data) {
    switch (data.type) {
      case "TOOLS_LIST": {
        const tools = data.tools.map((t) => ({
          namespacedName: t.name,
          originalName: t.name.replace(/^tab-\d+:/, ""),
          description: t.description,
          inputSchema: t.inputSchema,
          tabId: t.tabId,
          tabTitle: t.tabTitle,
          tabUrl: t.tabUrl
        }));
        this.updateTools(tools);
        break;
      }
      case "TOOL_RESULT": {
        const pending = this.pendingCalls.get(data.requestId);
        if (!pending) break;
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.pendingCalls.delete(data.requestId);
        if (data.error) {
          pending.resolve({
            isError: true,
            content: [{ type: "text", text: data.error }]
          });
        } else {
          pending.resolve({
            content: [{ type: "text", text: data.result ?? "" }]
          });
        }
        break;
      }
      case "TOOLS_CHANGED": {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          const msg = {
            type: "LIST_TOOLS",
            requestId: crypto.randomUUID()
          };
          this.ws.send(JSON.stringify(msg));
        }
        break;
      }
    }
  }
  clearConnection() {
    for (const [requestId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.resolve({
        isError: true,
        content: [{ type: "text", text: "Extension disconnected. Tool call aborted." }]
      });
      this.pendingCalls.delete(requestId);
    }
    this.tools.clear();
    this.fireChangeCallbacks();
  }
  onToolsChanged(cb) {
    this.changeCallbacks.push(cb);
  }
  fireChangeCallbacks() {
    for (const cb of this.changeCallbacks) {
      cb();
    }
  }
};

// src/mcp-server/index.ts
var PORT = Number(process.env.WEBMCP_BRIDGE_PORT) || 12315;
var registry = new ToolRegistry();
var server = new Server(
  { name: "webmcp-bridge", version: "0.1.0" },
  {
    capabilities: {
      tools: { listChanged: true }
    }
  }
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: registry.listMcpTools() };
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return registry.callTool(
    request.params.name,
    request.params.arguments ?? {},
    extra.signal
  );
});
registry.onToolsChanged(() => {
  server.sendToolListChanged().catch(() => {
  });
});
async function main() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  let extensionWs = null;
  wss.on("connection", (ws) => {
    console.error(`[WebMCP Bridge] Extension connected`);
    if (extensionWs) {
      extensionWs.close();
      registry.clearConnection();
    }
    extensionWs = ws;
    registry.setWebSocket(ws);
    ws.send(
      JSON.stringify({
        type: "LIST_TOOLS",
        requestId: crypto.randomUUID()
      })
    );
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw));
        registry.handleMessage(data);
      } catch {
        console.error("[WebMCP Bridge] Failed to parse WebSocket message");
      }
    });
    ws.on("close", () => {
      console.error("[WebMCP Bridge] Extension disconnected");
      if (extensionWs === ws) {
        extensionWs = null;
        registry.setWebSocket(null);
        registry.clearConnection();
      }
    });
    ws.on("error", (err) => {
      console.error("[WebMCP Bridge] WebSocket error:", err.message);
    });
  });
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[WebMCP Bridge] Port ${PORT} is already in use. Another instance may be running. Exiting.`
      );
      process.exit(1);
    }
    console.error("[WebMCP Bridge] WebSocket server error:", err.message);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[WebMCP Bridge] MCP server running, WebSocket on 127.0.0.1:${PORT}`
  );
}
main().catch((err) => {
  console.error("[WebMCP Bridge] Fatal:", err);
  process.exit(1);
});
//# sourceMappingURL=webmcp-server.js.map
