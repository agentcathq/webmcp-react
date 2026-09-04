# webmcp-react

React hooks for exposing typed tools on `document.modelContext`, aligned with the current [WebMCP](https://github.com/webmachinelearning/webmcp) specification.

[![npm version](https://img.shields.io/npm/v/webmcp-react)](https://www.npmjs.com/package/webmcp-react)
[![npm downloads](https://img.shields.io/npm/dm/webmcp-react)](https://www.npmjs.com/package/webmcp-react)
[![license](https://img.shields.io/npm/l/webmcp-react)](./LICENSE)
[![CI](https://github.com/agentcathq/webmcp-react/actions/workflows/ci.yml/badge.svg)](https://github.com/agentcathq/webmcp-react/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)

- **Zod-first.** Define inputs with Zod and get full type inference in handlers
- **JSON Schema support.** Pass raw JSON Schema when you do not use Zod
- **Built-in polyfill.** Installs a lightweight polyfill when native WebMCP is unavailable
- **SSR-safe.** Works with Next.js, Remix, and other server-rendering frameworks
- **StrictMode-safe.** Prevents duplicate registrations and orphaned tools
- **Spec-aligned.** Tracks the WebMCP specification and native Chrome behavior release by release

## Requirements

- React 18 or later
- Zod 3.25 or later, or Zod 4, as a peer dependency. Tools can also be defined with [JSON Schema](#json-schema).

## Install

```bash
npm install webmcp-react zod
```

## Quick start

Wrap your app in `<WebMCPProvider>` and register tools with `useMcpTool`:

```tsx
import { WebMCPProvider, useMcpTool } from "webmcp-react";
import { z } from "zod";

function SearchTool() {
  useMcpTool({
    name: "search",
    description: "Search the catalog",
    input: z.object({ query: z.string() }),
    handler: async ({ query }) => ({
      content: [{ type: "text", text: `Results for: ${query}` }],
    }),
  });
  return null;
}

export default function App() {
  return (
    <WebMCPProvider name="my-app" version="1.0">
      <SearchTool />
    </WebMCPProvider>
  );
}
```

The tool is now registered on `document.modelContext` and any WebMCP-compatible agent can call it.

### Agent skills

This repository ships [agent skills](./skills) that install webmcp-react and scaffold tools for you. Install them with the [skills CLI](https://skills.sh):

```bash
npx skills add agentcathq/webmcp-react
```

The skills work with Cursor, Claude Code, GitHub Copilot, Cline, and [18+ other agents](https://vercel.com/docs/agent-resources/skills).

## Playground

Try it live: [**WebMCP Wordle Demo**](https://agentcathq.github.io/webmcp-react/playground/)

The playground is a fully playable Wordle clone built on `webmcp-react` hooks. Tools register and unregister as the game moves through its phases (idle, playing, won, lost). You can make guesses with the keyboard or through an AI agent. A DevPanel shows the current tool state, and an easy-mode toggle enables a hint tool.

To play with an AI agent:

- **Codex.** Open the demo in Codex and ask it to play. Codex discovers and calls the page's WebMCP tools directly.
- **Claude, Cursor, and other MCP clients.** Install the [WebMCP Bridge extension](https://chromewebstore.google.com/detail/webmcp-bridge/chgjbookknohehmaocfijekhaocaanaf), open the demo in Chrome, and activate the extension for the page.

## How it works

[WebMCP](https://github.com/webmachinelearning/webmcp) is a proposed web standard from the W3C Web Machine Learning Community Group. It adds `document.modelContext` to the browser, an API that lets any page expose typed, callable tools to AI agents. Chrome ships the API in [Early Preview](https://developer.chrome.com/blog/webmcp-epp).

This library provides the React bindings for that API. `<WebMCPProvider>` installs a polyfill when native support is absent, and each `useMcpTool` call registers a tool that agents can discover and execute.

![How webmcp-react works](./docs/architecture.svg)

## Connect to AI clients

Agents with built-in WebMCP browser support, such as Codex, discover and call tools directly from the page. Clients that cannot access `document.modelContext` directly, such as Claude Code and Cursor, connect through the [WebMCP Bridge extension](https://chromewebstore.google.com/detail/webmcp-bridge/chgjbookknohehmaocfijekhaocaanaf), which exposes your registered tools to any MCP client.

1. Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/webmcp-bridge/chgjbookknohehmaocfijekhaocaanaf).
2. Configure your MCP client. See the [extension setup guide](./extension/README.md) for details.

The extension will be deprecated when Chrome provides native bridging to desktop clients.

## Usage

### Execution state

`useMcpTool` returns reactive state you can use to build UI around tool execution:

```tsx
function TranslateTool() {
  const { state, execute } = useMcpTool({
    name: "translate",
    description: "Translate text to Spanish",
    input: z.object({ text: z.string() }),
    handler: async ({ text }) => {
      const result = await translate(text, "es");
      return { content: [{ type: "text", text: result }] };
    },
  });

  return (
    <div>
      <button onClick={() => execute({ text: "Hello" })} disabled={state.isExecuting}>
        {state.isExecuting ? "Translating..." : "Translate"}
      </button>
      {state.lastResult && <p>{state.lastResult.content[0].text}</p>}
      {state.error && <p className="error">{state.error.message}</p>}
    </div>
  );
}
```

### Cancellation

Each execution receives its own `AbortSignal`. Pass it to `fetch` and other cancellable work. Chrome 153+ aborts the signal when the agent cancels the call. On older browsers the library substitutes a never-aborting signal, so the second argument is always safe to use:

```tsx
useMcpTool({
  name: "fetch_report",
  description: "Fetch a report by ID",
  input: z.object({ id: z.string() }),
  handler: async ({ id }, { signal }) => {
    const res = await fetch(`/api/reports/${id}`, { signal });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});
```

### Title and annotations

Give a tool a human-friendly display `title`, and describe its behavior to agents with `annotations`. The current WebMCP specification defines two annotations: `readOnlyHint` and `untrustedContentHint`.

```tsx
useMcpTool({
  name: "search_users",
  title: "Search users",
  description: "Find users by name or email",
  input: z.object({ query: z.string() }),
  annotations: {
    readOnlyHint: true,
  },
  handler: async ({ query }) => { /* ... */ },
});
```

### Dynamic tools

Tools register on mount and unregister on unmount. Render them conditionally like any React component:

```tsx
function App({ user }) {
  return (
    <WebMCPProvider name="app" version="1.0">
      <PublicTools />
      {user.isAdmin && <AdminTools />}
    </WebMCPProvider>
  );
}
```

### Callbacks

Run side effects on success or failure:

```tsx
useMcpTool({
  name: "checkout",
  description: "Complete a purchase",
  input: z.object({ cartId: z.string() }),
  handler: async ({ cartId }) => { /* ... */ },
  onSuccess: (result) => analytics.track("checkout_complete"),
  onError: (error) => toast.error(error.message),
});
```

### JSON Schema

Pass `inputSchema` directly to define a tool without Zod:

```tsx
useMcpTool({
  name: "calculate",
  description: "Basic arithmetic",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
      op: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
    },
    required: ["a", "b", "op"],
  },
  handler: async (args) => {
    const { a, b, op } = args as { a: number; b: number; op: string };
    const result = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b }[op];
    return { content: [{ type: "text", text: String(result) }] };
  },
});
```

### SSR

The library works with Next.js, Remix, and any server-rendering framework. The build includes a `"use client"` banner, so no extra configuration is needed.

## Browser support

| Environment | Behavior |
| --- | --- |
| Chrome with native `document.modelContext` | The library uses the native API. The polyfill is not installed. |
| All other browsers | The library installs its polyfill, which implements the registration and consumer APIs. |

The polyfill follows native Chrome behavior. See the [polyfill section of the API reference](./docs/api.md#polyfill-behavior) for the exact Chrome versions each behavior tracks.

## Versioning and stability

`webmcp-react` follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Breaking changes to the public API bump the major version. Every release is documented in the [changelog](./CHANGELOG.md), including the WebMCP specification and Chrome changes it tracks.

`outputSchema` and `structuredContent` are documented library extensions to the WebMCP specification. They are part of the public API and follow the same versioning policy.

## API

See the [full API reference](./docs/api.md).

## Contributing

Bug reports, feature requests, and pull requests are welcome. Read the [contributing guide](./CONTRIBUTING.md) before you open a pull request. This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
