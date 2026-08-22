---
name: webmcp-setup
description: Bootstraps webmcp-react into an existing React or Next.js app. Installs dependencies, adds WebMCPProvider, creates a first tool, and configures the MCP client bridge. Use when the user wants to set up WebMCP, add MCP tools to their app, integrate webmcp-react, or make their React app accessible to AI agents.
---

# Set Up webmcp-react

## Overview

`webmcp-react` exposes React app functionality as typed tools on `document.modelContext` (the W3C WebMCP API). AI agents discover and call these tools. This skill bootstraps the full setup.

## Step 1: Install dependencies

```bash
npm install webmcp-react zod
```

`zod` is a peer dependency used for typed tool input schemas.

## Step 2: Add WebMCPProvider

All `useMcpTool` calls must be descendants of `<WebMCPProvider>`. It installs a polyfill when native browser support is absent.

### React / Vite

Wrap the app root:

```tsx
import { WebMCPProvider } from "webmcp-react";

function App() {
  return (
    <WebMCPProvider name="my-app" version="1.0">
      {/* existing app content */}
    </WebMCPProvider>
  );
}
```

### Next.js (App Router)

Create a client component wrapper since webmcp-react uses browser APIs:

```tsx
// app/providers.tsx
"use client";

import { WebMCPProvider } from "webmcp-react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WebMCPProvider name="my-app" version="1.0">
      {children}
    </WebMCPProvider>
  );
}
```

Then wrap `children` in the root layout:

```tsx
// app/layout.tsx
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

The library ships with a `"use client"` banner in its build output, so no `transpilePackages` config is needed when installing from npm.

## Step 3: Create a first tool

Create a simple tool component to verify the wiring works:

```tsx
// components/mcp-tools.tsx  (add "use client" at top if Next.js)
import { useMcpTool } from "webmcp-react";
import { z } from "zod";

export function GreetTool() {
  useMcpTool({
    name: "greet",
    description: "Greet someone by name",
    input: z.object({
      name: z.string().describe("The name to greet"),
    }),
    handler: async ({ name }, { signal }) => {
      // signal aborts if the agent cancels — forward it to cancellable work
      const res = await fetch(`/api/greet?name=${encodeURIComponent(name)}`, { signal });
      return { content: [{ type: "text", text: await res.text() }] };
    },
  });
  return null;
}
```

Render it inside the provider:

```tsx
<WebMCPProvider name="my-app" version="1.0">
  <GreetTool />
  {/* rest of app */}
</WebMCPProvider>
```

## Step 4: Connect to AI clients

Desktop MCP clients (Cursor, Claude Code) cannot access `document.modelContext` directly. A Chrome extension + local MCP server bridges the gap.

### 4a. Install the Chrome extension

Install the "WebMCP Bridge" extension from the Chrome Web Store, or build from source:

```bash
git clone https://github.com/MCPCat/webmcp-react.git
cd webmcp-react/extension && pnpm install && pnpm build
```

Then load unpacked from `extension/dist/` at `chrome://extensions/`.

### 4b. Configure the MCP client

**Cursor** -- add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "webmcp-server": {
      "command": "npx",
      "args": ["webmcp-server"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add --transport stdio webmcp-server -- npx webmcp-server
```

### 4c. Activate the extension

1. Open your app in Chrome
2. Click the WebMCP Bridge extension icon
3. Choose "Always on" for persistent activation, or "Until reload" for one-shot testing
4. Green dot = connected to MCP client and tools are available

## Step 5: Verify

1. Run the app in the browser
2. Open the extension popup -- registered tools should appear
3. From Cursor or Claude Code, the tools should be discoverable and callable

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tools not appearing in AI client | Check extension is activated (green/yellow dot). Verify MCP server is running. |
| Yellow dot (no MCP connection) | Ensure `webmcp-server` is configured in your MCP client. Check port 12315 is free. |
| `useMcpTool` warning about missing provider | Ensure the component is rendered inside `<WebMCPProvider>`. |
| Next.js hydration errors | Add `"use client"` to any file using `useMcpTool` or `WebMCPProvider`. |
