# Changelog

All notable changes to `webmcp-react` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
