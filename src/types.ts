import type { ReactNode } from "react";
import type { z } from "zod";

export type MaybePromise<T> = T | Promise<T>;

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
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ModelContextClient {
  requestUserInteraction(callback: () => Promise<unknown>): Promise<unknown>;
}

export interface ToolDescriptor<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema?: InputSchema;
  outputSchema?: InputSchema;
  annotations?: ToolAnnotations;
  execute: (args: TArgs, client: ModelContextClient) => MaybePromise<CallToolResult>;
}

interface McpToolConfigBase {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  onSuccess?: (result: CallToolResult) => void;
  onError?: (error: Error) => void;
}

export interface McpToolConfigZod<T extends z.ZodRawShape> extends McpToolConfigBase {
  input: z.ZodObject<T>;
  inputSchema?: never;
  output?: z.ZodObject<z.ZodRawShape>;
  outputSchema?: never;
  handler: (
    args: z.infer<z.ZodObject<T>>,
    client: ModelContextClient,
  ) => MaybePromise<CallToolResult>;
}

export interface McpToolConfigJsonSchema extends McpToolConfigBase {
  input?: never;
  inputSchema?: InputSchema;
  output?: never;
  outputSchema?: InputSchema;
  handler: (
    args: Record<string, unknown>,
    client: ModelContextClient,
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
  execute: (input?: Record<string, unknown>) => Promise<TResult>;
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

export interface ModelContext {
  registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): Promise<undefined>;
}

export interface ModelContextTestingToolInfo {
  name: string;
  description: string;
  inputSchema?: string;
}

export interface ModelContextTestingExecuteToolOptions {
  signal?: AbortSignal;
}

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
  interface Navigator {
    modelContext?: ModelContext;
    modelContextTesting?: ModelContextTesting;
  }
}
