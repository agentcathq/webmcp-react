# Privacy Policy — WebMCP Bridge

**Last updated:** July 2026

## Overview

WebMCP Bridge is an open-source Chrome extension that connects tools registered on web pages (via the `document.modelContext` browser API) to local AI assistants through Model Context Protocol (MCP). It does not collect, store, or transmit any personal data.

## What data does the extension access?

The extension does not collect any personal data, browsing history, or identifying information.

It reads **tool registrations** exposed by web pages through the standard `document.modelContext` API (`getTools()` / `executeTool()`). These are developer-defined function names, descriptions, and input schemas — not user content or page data. Pages using webmcp-react ≤1.0.0 are still supported via the deprecated `navigator.modelContextTesting` shim.

## How is data transmitted?

All communication stays on your machine. The extension connects to a local MCP server over `ws://127.0.0.1:12315`. No data is sent to external servers, third-party services, or the internet.

## What is stored locally?

The extension uses Chrome's `storage.local` API to persist your **domain activation preferences** — which websites you've chosen to always enable the extension on. No other data is stored.

## Permissions explained

| Permission | Why it's needed |`
| --- | --- |
| `tabs` | Read the URL and title of active tabs to display them in the popup and namespace tools by tab |
| `scripting` | Inject content scripts that read tool registrations from `document.modelContext` |
| `activeTab` | Inject scripts into the current tab when you click "Until reload" |
| `storage` | Persist your domain activation preferences across browser sessions |
| Host permissions (optional, per-domain) | Requested at runtime when you enable "Always on" for a site — allows the extension to auto-inject on future visits to that domain |

## Data lifecycle

Tool registrations are held in memory only while the tab is active. When a tab is closed, navigated away, or deactivated, its tools are immediately removed. Domain activation preferences stored via `storage.local` are cleared when you switch a site to "Off" or uninstall the extension.

## Third-party services

None. The extension has no analytics, telemetry, crash reporting, or external network calls.

## Contact

This extension is open source. For questions or concerns, open an issue at <https://github.com/mcpcat/webmcp-react/issues>.
