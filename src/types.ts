import type { ReactNode } from "react";
import type * as z3 from "zod/v3";
import type * as z4 from "zod/v4/core";

export type MaybePromise<T> = T | Promise<T>;

/** Second argument to a tool's execute callback / useMcpTool handler (Chrome 153+ shape). */
export interface ToolExecuteCallbackOptions {
  signal: AbortSignal;
}

/** Options for ModelContext.executeTool and UseMcpToolReturn.execute. */
export interface ExecuteToolOptions {
  signal?: AbortSignal;
}

export interface InputSchemaProperty {
  type: string;
  description?: string;
  [key: string]: unknown;
}

export interface InputSchema {
  type: string;
  properties?: Record<string, InputSchemaProperty>;
  required?: readonly string[];
  [key: string]: unknown;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface TextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface BlobResourceContents {
  uri: string;
  mimeType?: string;
  blob: string;
}

export type ResourceContents = TextResourceContents | BlobResourceContents;

export interface EmbeddedResource {
  type: "resource";
  resource: ResourceContents;
}

export interface ResourceLink {
  type: "resource_link";
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export type ContentBlock = TextContent | ImageContent | EmbeddedResource | ResourceLink;

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolDescriptor<TArgs = Record<string, unknown>> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: InputSchema;
  outputSchema?: InputSchema;
  annotations?: ToolAnnotations;
  execute: (input: TArgs, options: ToolExecuteCallbackOptions) => MaybePromise<CallToolResult>;
}

interface McpToolConfigBase {
  name: string;
  title?: string;
  description: string;
  annotations?: ToolAnnotations;
  exposedTo?: string[];
  onSuccess?: (result: CallToolResult) => void;
  onError?: (error: Error) => void;
}

export type ZodObjectSchema = z3.AnyZodObject | z4.$ZodObject;

/** Parsed schema output — same semantics as Zod's `z.infer`. */
export type ZodParsed<T extends ZodObjectSchema> = T extends z4.$ZodType
  ? z4.output<T>
  : T extends z3.ZodTypeAny
    ? z3.infer<T>
    : never;

export interface McpToolConfigZod<T extends ZodObjectSchema = ZodObjectSchema>
  extends McpToolConfigBase {
  input: T;
  inputSchema?: never;
  output?: ZodObjectSchema;
  outputSchema?: never;
  handler: (args: ZodParsed<T>, ctx: ToolExecuteCallbackOptions) => MaybePromise<CallToolResult>;
}

export interface McpToolConfigJsonSchema extends McpToolConfigBase {
  input?: never;
  inputSchema?: InputSchema;
  output?: never;
  outputSchema?: InputSchema;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolExecuteCallbackOptions,
  ) => MaybePromise<CallToolResult>;
}

export interface ToolExecutionState<TResult = CallToolResult> {
  isExecuting: boolean;
  lastResult: TResult | null;
  error: Error | null;
  executionCount: number;
}

export interface UseMcpToolReturn<TResult = CallToolResult> {
  state: ToolExecutionState<TResult>;
  execute: (input?: Record<string, unknown>, options?: ExecuteToolOptions) => Promise<TResult>;
  reset: () => void;
}

export interface WebMCPProviderProps {
  name: string;
  version: string;
  children: ReactNode;
}

export interface WebMCPStatus {
  available: boolean;
}

export interface RegisterToolOptions {
  signal?: AbortSignal;
  exposedTo?: string[];
}

/**
 * Tool metadata returned by ModelContext.getTools().
 * `inputSchema` is an object on Chrome 154+ and this library's polyfill, but a
 * JSON string on Chrome <=153 — consumers must handle both:
 * `typeof s === "string" ? JSON.parse(s) : s`.
 */
export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: InputSchema | string;
  annotations?: ToolAnnotations;
  window?: Window;
  origin?: string;
}

export interface ModelContextGetToolOptions {
  fromOrigins?: string[];
}

export interface ModelContext extends EventTarget {
  registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): Promise<undefined>;
  getTools?(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>;
  executeTool?(
    tool: RegisteredTool,
    inputArguments: string | object,
    options?: ExecuteToolOptions,
  ): Promise<string | null>;
  ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null;
  addEventListener(
    type: "toolchange",
    listener: (ev: Event) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "toolchange",
    listener: (ev: Event) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** @deprecated Removed from native Chrome in 152; use ModelContext.getTools()/executeTool(). Will be removed in webmcp-react 2.0.0. */
export interface ModelContextTestingToolInfo {
  name: string;
  description: string;
  inputSchema?: string;
}

/** @deprecated Removed from native Chrome in 152. Will be removed in webmcp-react 2.0.0. */
export interface ModelContextTestingExecuteToolOptions {
  signal?: AbortSignal;
}

/** @deprecated Removed from native Chrome in 152; use document.modelContext.getTools()/executeTool(). Will be removed in webmcp-react 2.0.0. */
export interface ModelContextTesting {
  listTools(): ModelContextTestingToolInfo[];
  executeTool(
    toolName: string,
    inputArgsJson: string,
    options?: ModelContextTestingExecuteToolOptions,
  ): Promise<string | null>;
  registerToolsChangedCallback(callback: () => void): void;
  getCrossDocumentScriptToolResult(): Promise<string>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContextTesting?: ModelContextTesting;
  }
}
