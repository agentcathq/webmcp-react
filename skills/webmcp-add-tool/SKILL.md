---
name: webmcp-add-tool
description: Scaffolds a new WebMCP tool component using useMcpTool with Zod schema, handler, annotations, and wires it into the WebMCPProvider tree. Use when the user wants to expose functionality as an MCP tool, make something callable by AI, add a new tool, or create an AI-accessible action.
---

# Add a WebMCP Tool

## Overview

Each tool is a React component that calls `useMcpTool`. It registers on mount, unregisters on unmount. Tools can be headless (return `null`) or render UI showing execution state.

## Workflow

1. **Determine** the tool's name, description, input schema, and what the handler does
2. **Choose** headless vs UI tool
3. **Scaffold** using the appropriate template below
4. **Set annotations** based on tool behavior
5. **Wire** the component into the `<WebMCPProvider>` tree

## Template: Headless tool

For tools that do work without rendering anything visible:

```tsx
import { useMcpTool } from "webmcp-react";
import { z } from "zod";

export function MyTool() {
  useMcpTool({
    name: "my_tool",
    description: "One-line description of what this tool does",
    input: z.object({
      // Define each input field with .describe() for AI context
      query: z.string().describe("The search query"),
    }),
    handler: async ({ query }) => {
      // Implement tool logic here
      const result = await doSomething(query);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  });
  return null;
}
```

## Template: Tool with execution state UI

For tools that show loading, results, or errors:

```tsx
import { useMcpTool } from "webmcp-react";
import { z } from "zod";

export function MyTool() {
  const { state, execute, reset } = useMcpTool({
    name: "my_tool",
    description: "One-line description of what this tool does",
    input: z.object({
      text: z.string().describe("Input text to process"),
    }),
    handler: async ({ text }) => {
      const result = await process(text);
      return { content: [{ type: "text", text: result }] };
    },
    onSuccess: (result) => {
      // Optional: analytics, toast, etc.
    },
    onError: (error) => {
      // Optional: error reporting
    },
  });

  return (
    <div>
      <button onClick={() => execute({ text: "hello" })} disabled={state.isExecuting}>
        {state.isExecuting ? "Processing..." : "Run"}
      </button>
      {state.lastResult && <p>{state.lastResult.content[0].text}</p>}
      {state.error && <p className="error">{state.error.message}</p>}
      <span>Executions: {state.executionCount}</span>
    </div>
  );
}
```

## Title and annotations

Use the top-level `title` for a human-friendly display name, and `annotations` to hint AI agents about tool behavior. Only include annotations that apply:

```tsx
useMcpTool({
  name: "my_tool",
  title: "Human-friendly title",          // Optional display name for the tool
  // ...
  annotations: {
    readOnlyHint: true,                    // Tool only reads data, no side effects
    untrustedContentHint: true,            // Tool may return content from untrusted sources
  },
});
```

`ToolAnnotations` is only `{ readOnlyHint?: boolean; untrustedContentHint?: boolean }`. There is no `title` inside `annotations` (it is a top-level field), and the older `destructiveHint`, `idempotentHint`, and `openWorldHint` hints no longer exist.

**Guideline for choosing fields:**

| Tool behavior | What to set |
|---|---|
| Needs a display name | top-level `title: "..."` |
| Fetches/queries data, no side effects | `annotations: { readOnlyHint: true }` |
| Returns content from untrusted sources (user input, external APIs) | `annotations: { untrustedContentHint: true }` |
| Creates/updates/deletes data | omit `readOnlyHint` (a tool with side effects should not claim it is read-only) |

## Return format

Handlers must return `CallToolResult`:

```tsx
// Text content (most common)
return {
  content: [{ type: "text", text: "result string" }],
};

// Structured content (for machine-readable results alongside text)
return {
  content: [{ type: "text", text: "Human summary" }],
  structuredContent: { key: "value", count: 42 },
};

// Error result (caught by the framework, but you can also return errors explicitly)
return {
  content: [{ type: "text", text: "Something went wrong" }],
  isError: true,
};

// Image content
return {
  content: [{ type: "image", data: base64String, mimeType: "image/png" }],
};
```

## Dynamic tools

Tools register on mount and unregister on unmount. Use conditional rendering to dynamically control which tools are available:

```tsx
function App({ user }) {
  return (
    <WebMCPProvider name="app" version="1.0">
      <PublicTools />
      {user.isAdmin && <AdminTools />}
      {featureFlags.betaSearch && <BetaSearchTool />}
    </WebMCPProvider>
  );
}
```

## Wiring into the provider

Render the tool component anywhere inside `<WebMCPProvider>`. Common patterns:

**Dedicated tools file** (recommended for apps with many tools):

```tsx
// components/mcp-tools.tsx
export function McpTools() {
  return (
    <>
      <SearchTool />
      <TranslateTool />
      <CheckoutTool />
    </>
  );
}

// In app root:
<WebMCPProvider name="app" version="1.0">
  <McpTools />
  <App />
</WebMCPProvider>
```

**Colocated with feature** (when the tool is tightly coupled to a specific component):

```tsx
function ProductPage({ product }) {
  return (
    <div>
      <ProductDetails product={product} />
      <AddToCartTool productId={product.id} />
    </div>
  );
}
```

## Naming conventions

- Tool names: `snake_case` (e.g., `search_catalog`, `delete_user`, `get_order_status`)
- Component names: PascalCase ending in `Tool` (e.g., `SearchCatalogTool`, `DeleteUserTool`)
- Descriptions: start with a verb, be specific (e.g., "Search the product catalog by keyword" not "Search stuff")

## Checklist

Before finishing, verify:

- [ ] Tool name is unique across the app
- [ ] Description clearly explains what the tool does (AI agents read this)
- [ ] All input fields have `.describe()` for AI context
- [ ] Handler returns `CallToolResult` with `content` array
- [ ] Appropriate annotations are set
- [ ] Component is rendered inside `<WebMCPProvider>`
- [ ] For Next.js: file has `"use client"` directive
