# Changelog

All notable changes to `webmcp-react` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.0

Tracks Chrome 152–154 WebMCP changes: execution AbortSignals, the
`document.modelContext` consumer API, and the removal of
`navigator.modelContextTesting` from native Chrome.

### Added

- **Handlers receive an execution `AbortSignal`.** Handlers are now called as
  `handler(args, { signal })`; on Chrome 153.0.8007.0+ the signal aborts when the agent or
  user cancels the call — pass it to `fetch()` and other cancellable work. On Chrome ≤152
  (and for bare `execute(args)` calls) the library substitutes a never-aborting signal, so
  the second argument is always safe to use. The hook's `execute(input?, { signal }?)`
  accepts a caller signal too. Existing one-argument handlers keep working unchanged.
- **Polyfill consumer API.** `document.modelContext.getTools()` and
  `executeTool(tool, inputArguments, { signal }?)`, matching native Chrome:
  `RegisteredTool.inputSchema` is a deep-copied object (Chrome 154.0.8014.0+ shape),
  `inputArguments` may be a JSON string or an object, execution failures reject with
  `UnknownError`, aborts reject with the signal's reason, and unregistering a tool no
  longer cancels in-flight executions (Chrome 153.0.8008.0+ behavior). The polyfill
  additionally validates input against `inputSchema` (`OperationError`) — native Chrome
  does not validate yet.
- New exported types: `ToolExecuteCallbackOptions`, `ExecuteToolOptions`,
  `RegisteredTool`, `ModelContextGetToolOptions`.

### Changed

- **Abort is cancellation, not error.** When an execution's signal aborts and the handler
  rejects, the hook clears `isExecuting` but leaves `state.error` untouched and does not
  fire `onError`.
- The testing shim's abort rejections now use the signal's abort reason and its tool
  failures reject with `UnknownError` (Chrome 152+ parity); its `OperationError` input
  errors and `NotFoundError` are unchanged.

### Deprecated

- **`navigator.modelContextTesting`.** Native Chrome removed it in 152.0.7940.0. The
  polyfill's shim now delegates to the same engine as `document.modelContext.executeTool()`
  and warns once in dev. It will be removed in webmcp-react 2.0.0.

### Extension

- The bridge extension now discovers and executes tools via
  `document.modelContext.getTools()` / `executeTool()` (native Chrome 150.0.7861.0+ and the
  webmcp-react 1.1.0 polyfill), falling back to the deprecated
  `navigator.modelContextTesting` for pages on webmcp-react ≤1.0.0. Native Chrome removed
  `modelContextTesting` in 152.0.7940.0, which had left the extension unable to see tools
  on native Chrome.
- MCP client cancellations (`notifications/cancelled`) are forwarded end-to-end: MCP SDK →
  WebSocket `CANCEL_TOOL` → background → content scripts → `executeTool`'s `AbortSignal`,
  aborting the tool handler's execution signal.
- Ships as `webmcp-server` 0.2.0 (the bin is regenerated) and bridge extension 0.2.0.

## 1.0.0

First stable release. From here on, breaking changes to the public API bump the major version.

### Added

- **Zod 4 support.** The `zod` peer dependency range is now `^3.25.0 || ^4.0.0`. `useMcpTool`
  accepts Zod 4 and Zod Mini object schemas for `input` / `output`, converts them to JSON Schema
  with Zod's native `toJSONSchema`, and validates them through `zod/v4/core`. Classic Zod 3
  schemas keep going through `zod-to-json-schema` and `schema.parse`. Zod 3.25 is the new floor
  because it ships the `zod/v4/core` entry point the library imports.

### Changed

- **Already-aborted `AbortSignal` now rejects.** The polyfill's `registerTool` rejects with the
  signal's abort reason when handed an already-aborted signal, matching WebMCP spec PR #202 and
  native Chrome 152.0.7943.0. Previously it resolved as a no-op, matching native Chrome 151.
  Validation errors still take precedence over the aborted-signal check. `useMcpTool` is
  unaffected: it never passes a pre-aborted signal, and `AbortError` rejections are already
  treated as lifecycle teardown.
- Docs and npm keywords now reference `document.modelContext`; `navigator.modelContext` was
  removed from Chrome as of 152.0.7943.0 (the library itself migrated in 0.2.0).

## 0.2.0

Realigns the library with the current [WebMCP](https://github.com/webmachinelearning/webmcp)
spec. This is a clean break — the public surface (`<WebMCPProvider>`, `useMcpTool`,
`useWebMCPStatus`) is unchanged in shape, but the underlying WebMCP wiring has breaking
changes.

### Breaking changes

- **API moved to `document.modelContext`.** The registration API is now installed and detected
  on `document.modelContext` instead of `navigator.modelContext`. Native detection is
  document-only — `navigator.modelContext` is no longer read or written. (The testing/consumer
  API stays on `navigator.modelContextTesting`.)
- **`registerTool` returns a `Promise`.** The polyfill's `registerTool(tool, options?)` now
  returns a `Promise<undefined>` that rejects on:
  - an empty/missing name, a name longer than 128 chars, or a name not matching
    `^[A-Za-z0-9_.-]+$`;
  - a duplicate name already registered;
  - an empty/missing description;
  - an `execute` that is not a function;
  - a non-serializable `inputSchema`;
  - an `exposedTo` entry that is not a parseable, potentially-trustworthy origin.

  Already-aborted `AbortSignal` passed to `registerTool` resolves as a no-op (registration is
  skipped), matching native Chrome 151. (Note: WebMCP spec PR #202 specifies rejection; native had
  not shipped that as of Chrome 151. Revisit if native changes.)

  `useMcpTool` routes these rejections into `state.error` and `onError`, except `AbortError`
  (lifecycle teardown), which is ignored.
- **Unregistration is AbortSignal-only.** There is no `unregisterTool`. Tools are removed by
  aborting the `AbortSignal` passed via `registerTool`'s options; `useMcpTool` does this on
  unmount.
- **Single-argument handlers.** Tool `execute(input)` and user `handler(args)` now take a single
  argument. `ModelContextClient` and `requestUserInteraction` are removed entirely.
- **`ToolAnnotations` narrowed** to `{ readOnlyHint?, untrustedContentHint? }`. The classic MCP
  hints (`destructiveHint`, `idempotentHint`, `openWorldHint`) and `annotations.title` are
  removed.
- **Top-level `title?` added** to the tool config and descriptor (replacing the dropped
  `annotations.title`).
- **`exposedTo?: string[]` added** to the tool config and `RegisterToolOptions` for cross-frame
  origin visibility. Changing `exposedTo` re-registers the tool.
- **`toolchange` event.** `document.modelContext` is an `EventTarget` that fires a bare
  `toolchange` event (no `detail`) on tool register/unregister. `addEventListener("toolchange",
  ...)` and an `ontoolchange` handler are both supported.

### Retained library extensions

- **`outputSchema`** (Zod `output` / JSON-Schema `outputSchema`) is kept as a documented library
  extension, not part of the spec descriptor.
- **`structuredContent`** on `CallToolResult` is retained.
- **Handlers always return a `CallToolResult`** with a `content` array (including error results
  with `isError: true`) — a deliberate convention layered over the spec's looser return type so
  results bridge cleanly to desktop MCP clients.

### Notes

- The **already-aborted-signal** behavior was confirmed against native Chrome 151: native skips
  registration and resolves with `undefined` (a no-op) rather than rejecting, so the polyfill
  matches. (WebMCP spec PR #202 specifies rejection; native had not shipped that as of Chrome 151.
  Revisit if native changes.)

## 0.1.0

- Initial release: `<WebMCPProvider>`, `useMcpTool`, and `useWebMCPStatus` with a
  `navigator.modelContext` polyfill, Zod and JSON-Schema tool definitions, and a testing shim.
