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
    handler: async ({ query }, { signal }) => {
      // signal aborts if the agent cancels — forward it to cancellable work
      const result = await doSomething(query, { signal });
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
    consequentialHint: true,               // Tool has real-world or irreversible effects
    debugging: true,                       // Tool is for developers, not end users
  },
});
```

`ToolAnnotations` is only `{ readOnlyHint?, untrustedContentHint?, consequentialHint?, debugging? }`, all booleans. There is no `title` inside `annotations` (it is a top-level field), and the older `destructiveHint`, `idempotentHint`, and `openWorldHint` hints no longer exist.

**Guideline for choosing fields:**

| Tool behavior | What to set |
|---|---|
| Needs a display name | top-level `title: "..."` |
| Fetches/queries data, no side effects | `annotations: { readOnlyHint: true }` |
| Returns content from untrusted sources (user input, external APIs) | `annotations: { untrustedContentHint: true }` |
| Creates/updates/deletes data | omit `readOnlyHint` (a tool with side effects should not claim it is read-only) |
| Does something hard to undo (payments, bookings, sending messages, permanent deletes) | `annotations: { consequentialHint: true }` |
| Only useful to developers (state dumps, test helpers) | `annotations: { debugging: true }` |

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

// Error result built by hand (usually you just throw, see Errors below)
return {
  content: [{ type: "text", text: "Something went wrong" }],
  isError: true,
};

// Image content
return {
  content: [{ type: "image", data: base64String, mimeType: "image/png" }],
};
```

Keep results small. The agent reads all of it, `structuredContent` and base64 images included. Google's WebMCP guidance aims for about 1,500 characters. For long lists, take `page` and `page_size` inputs and return `total_count` instead of everything at once.

If the tool changes what's on screen (navigates, opens a dialog, updates a list), wait for that update before returning so the agent sees the page in its new state.

## Errors

Throw when the tool can't do what was asked. The hook catches it, sets `state.error`, calls `onError`, and the agent gets an `isError` result with your message. Write the message for the agent and say what to do next:

```tsx
handler: async ({ code }) => {
  const coupon = await findCoupon(code);
  if (!coupon) {
    throw new Error(`Coupon "${code}" is invalid or expired. Ask the user for another code.`);
  }
  // ...
},
```

Returning `{ isError: true, ... }` yourself also reaches the agent as an error, but the hook treats it as a success: `state.lastResult` holds it and `onSuccess` fires, not `onError`. Use that only when you want to control the exact result, e.g. to add `structuredContent` like `{ retryable: true }`.

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

## Names, descriptions and inputs

- Tool names: `snake_case` (e.g., `search_catalog`, `delete_user`, `get_order_status`), ideally under 30 characters
- Component names: PascalCase ending in `Tool` (e.g., `SearchCatalogTool`, `DeleteUserTool`)
- Name the tool for what actually happens. `book_flight` books the flight. A tool that only opens the booking form is `start_booking`, and it isn't read-only because it changes the page.
- One tool per capability. If two tools could both answer the same request, merge them or make the difference obvious.
- Descriptions say what the tool does and when to pick it: "Search the product catalog by keyword or category. Use when the user wants to find or compare products." Not "Search stuff".
- Don't list the inputs in the description, the schema already tells the agent. Leave out implementation details too (Redux, REST, cache invalidation).
- Keep descriptions under about 500 characters and each `.describe()` under about 150.
- Accept input the way the user says it. For dates, take "next Friday" as well as an ISO date and resolve it in the app; agents often get today's date or the timezone wrong.
- Prefer names over internal IDs (`shipping: "express"`, not `shipping_id: 1`). IDs the agent got from another tool's result are fine.

## Checklist

Before finishing, verify:

- [ ] Tool name is unique across the app
- [ ] Description says what the tool does and when to use it (AI agents read this)
- [ ] All input fields have `.describe()` for AI context
- [ ] Handler returns `CallToolResult` with `content` array
- [ ] Failures throw an error message that tells the agent what to do next
- [ ] Results stay small, and long lists are paginated
- [ ] Appropriate annotations are set
- [ ] Component is rendered inside `<WebMCPProvider>`
- [ ] For Next.js: file has `"use client"` directive
