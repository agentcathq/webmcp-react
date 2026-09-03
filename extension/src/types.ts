/** @deprecated Removed from native Chrome in 152; kept as a fallback for pages on webmcp-react <=1.0.0. */
interface ModelContextTesting {
  listTools(): BrowserTool[];
  executeTool(
    toolName: string,
    inputArgsJson: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
  registerToolsChangedCallback(callback: () => void): void;
}

export interface PageRegisteredTool {
  name: string;
  title?: string;
  description: string;
  /** JSON string on Chrome <=153, object on Chrome 154+ / webmcp-react 1.1.0 polyfill. */
  inputSchema?: string | object;
  annotations?: Record<string, unknown>;
  window?: Window;
  origin?: string;
}

export interface PageModelContext extends EventTarget {
  getTools?(options?: { fromOrigins?: string[] }): Promise<PageRegisteredTool[]>;
  executeTool?(
    tool: PageRegisteredTool,
    inputArguments: string | object,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
}

declare global {
  interface Navigator {
    modelContextTesting?: ModelContextTesting;
  }
  interface Document {
    modelContext?: PageModelContext;
  }
}

export interface BrowserTool {
  name: string;
  description: string;
  inputSchema?: string; // JSON-stringified JSON Schema
}

// No auth on page messages — MAIN world has the same privileges as registerTool().

export interface PageToolsUpdatedMessage {
  type: "WEBMCP_TOOLS_UPDATED";
  tools: BrowserTool[];
}

export interface PageToolResultMessage {
  type: "WEBMCP_TOOL_RESULT";
  requestId: string;
  result: string | null;
  error?: string;
}

export interface PageExecuteToolMessage {
  type: "WEBMCP_EXECUTE_TOOL";
  requestId: string;
  toolName: string;
  argsJson: string;
}

export interface PageRequestToolsMessage {
  type: "WEBMCP_REQUEST_TOOLS";
}

export interface PageCancelToolMessage {
  type: "WEBMCP_CANCEL_TOOL";
  requestId: string;
}

export type PageMessage =
  | PageToolsUpdatedMessage
  | PageToolResultMessage
  | PageExecuteToolMessage
  | PageRequestToolsMessage
  | PageCancelToolMessage;

export interface RuntimeToolsUpdatedMessage {
  type: "TOOLS_UPDATED";
  tools: BrowserTool[];
}

export interface RuntimeToolResultMessage {
  type: "TOOL_RESULT";
  requestId: string;
  result: string | null;
  error?: string;
}

export interface RuntimeExecuteToolMessage {
  type: "EXECUTE_TOOL";
  requestId: string;
  toolName: string;
  argsJson: string;
}

export interface RuntimeRequestToolsMessage {
  type: "REQUEST_TOOLS";
}

export interface RuntimeCancelToolMessage {
  type: "CANCEL_TOOL";
  requestId: string;
}

export interface RuntimeGetStatusMessage {
  type: "GET_STATUS";
  tabId?: number;
}

export interface RuntimeActivateTabMessage {
  type: "ACTIVATE_TAB";
  tabId: number;
}

export interface RuntimeActivateDomainMessage {
  type: "ACTIVATE_DOMAIN";
  tabId: number;
  origin: string;
}

export interface RuntimeDeactivateTabMessage {
  type: "DEACTIVATE_TAB";
  tabId: number;
}

export interface RuntimeDeactivateDomainMessage {
  type: "DEACTIVATE_DOMAIN";
  origin: string;
}

export interface RuntimeStatusMessage {
  type: "STATUS";
  tabs: Array<{
    tabId: number;
    title: string;
    url: string;
    toolCount: number;
    toolNames: string[];
  }>;
  mcpServerConnected: boolean;
  activatedTabs: number[];
  activatedDomains: string[];
  currentTabActivation: "off" | "tab" | "domain";
}

export type RuntimeMessage =
  | RuntimeToolsUpdatedMessage
  | RuntimeToolResultMessage
  | RuntimeExecuteToolMessage
  | RuntimeRequestToolsMessage
  | RuntimeCancelToolMessage
  | RuntimeGetStatusMessage
  | RuntimeActivateTabMessage
  | RuntimeActivateDomainMessage
  | RuntimeDeactivateTabMessage
  | RuntimeDeactivateDomainMessage
  | RuntimeStatusMessage;

export interface WsListToolsRequest {
  type: "LIST_TOOLS";
  requestId: string;
}

export interface WsToolsListResponse {
  type: "TOOLS_LIST";
  requestId: string;
  tools: Array<{
    name: string; // namespaced: "tab-{id}:{name}"
    description: string;
    inputSchema?: object; // parsed JSON Schema
    tabId: number;
    tabTitle: string;
    tabUrl: string;
  }>;
}

export interface WsCallToolRequest {
  type: "CALL_TOOL";
  requestId: string;
  tabId: number;
  toolName: string;
  argsJson: string;
}

export interface WsCancelToolRequest {
  type: "CANCEL_TOOL";
  requestId: string;
}

export interface WsToolResultResponse {
  type: "TOOL_RESULT";
  requestId: string;
  result: string | null;
  error?: string;
}

export interface WsToolsChangedNotification {
  type: "TOOLS_CHANGED";
}

export type WsMessageFromServer =
  | WsListToolsRequest
  | WsCallToolRequest
  | WsCancelToolRequest;

export type WsMessageFromExtension =
  | WsToolsListResponse
  | WsToolResultResponse
  | WsToolsChangedNotification;

export interface AggregatedTool {
  namespacedName: string; // "tab-123:filter_products"
  originalName: string;
  description: string;
  inputSchema?: object; // parsed JSON Schema
  tabId: number;
  tabTitle: string;
  tabUrl: string;
}
