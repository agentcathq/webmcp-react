import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { WsMessageFromExtension } from "../types.js";
import { ToolRegistry } from "./tool-registry.js";

const PORT = Number(process.env.WEBMCP_BRIDGE_PORT) || 12315;

const registry = new ToolRegistry();

const server = new Server(
  { name: "webmcp-bridge", version: "0.1.0" },
  {
    capabilities: {
      tools: { listChanged: true },
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: registry.listMcpTools() };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return registry.callTool(
    request.params.name,
    (request.params.arguments as Record<string, unknown>) ?? {},
    extra.signal,
  );
});

// Notify MCP clients when tools change
registry.onToolsChanged(() => {
  server.sendToolListChanged().catch(() => {
    // Client may not be connected yet — ignore
  });
});

async function main() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  let extensionWs: WebSocket | null = null;

  wss.on("connection", (ws) => {
    console.error(`[WebMCP Bridge] Extension connected`);

    // Only allow one extension connection at a time
    if (extensionWs) {
      extensionWs.close();
      registry.clearConnection();
    }

    extensionWs = ws;
    registry.setWebSocket(ws);

    // Request initial tool list
    ws.send(
      JSON.stringify({
        type: "LIST_TOOLS",
        requestId: crypto.randomUUID(),
      }),
    );

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw)) as WsMessageFromExtension;
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

  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[WebMCP Bridge] Port ${PORT} is already in use. Another instance may be running. Exiting.`,
      );
      process.exit(1);
    }
    console.error("[WebMCP Bridge] WebSocket server error:", err.message);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[WebMCP Bridge] MCP server running, WebSocket on 127.0.0.1:${PORT}`,
  );
}

main().catch((err) => {
  console.error("[WebMCP Bridge] Fatal:", err);
  process.exit(1);
});
