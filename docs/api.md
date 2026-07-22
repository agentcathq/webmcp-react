# API Reference

This library targets the current [WebMCP](https://github.com/webmachinelearning/webmcp) spec. The registration API lives on `document.modelContext` (an `EventTarget`), and the testing/consumer API lives on `navigator.modelContextTesting`.

## `<WebMCPProvider>`

Recommended root wrapper for apps using this library.

| Prop       | Type        | Description        |
| ---------- | ----------- | ------------------ |
| `name`     | `string`    | Your app's name    |
| `version`  | `string`    | Your app's version |
| `children` | `ReactNode` | React children     |

On mount, the provider checks for native `document.modelContext`. If absent, it installs a minimal in-memory polyfill. It cleans up the polyfill when the last provider unmounts (the polyfill is ref-counted across providers).

`useMcpTool` can still run outside the provider (with a warning), but registration depends on `document.modelContext` already being present.

## `useWebMCPStatus()`

Returns the current availability of the WebMCP API.

```tsx
const { available } = useWebMCPStatus();
```

| Field       | Type      | Description                                                                  |
| ----------- | --------- | ---------------------------------------------------------------------------- |
| `available` | `boolean` | `true` once `document.modelContext` is ready (always `false` on the server or outside a provider) |

## `useMcpTool(config)`

Registers a tool on `document.modelContext`. Automatically unregisters on unmount (via `AbortSignal` — there is no `unregisterTool`).

### Zod config

| Field         | Type                            | Description                                                    |
| ------------- | ------------------------------- | -------------------------------------------------------------- |
| `name`        | `string`                        | Tool name (must be unique, 1–128 chars, matching `^[A-Za-z0-9_.-]+$`) |
| `title`       | `string`                        | Optional human-friendly display title                          |
| `description` | `string`                        | Human-readable description (required, non-empty)               |
| `input`       | `z.ZodObject`                   | Zod schema for inputs. Handler receives typed args             |
| `output`      | `z.ZodObject`                   | Optional Zod schema for outputs (library extension; see below) |
| `annotations` | `ToolAnnotations`               | Optional behavior hints (`readOnlyHint`, `untrustedContentHint`) |
| `exposedTo`   | `string[]`                      | Optional list of trustworthy origins this tool is exposed to across frames |
| `handler`     | `(args) => CallToolResult \| Promise<CallToolResult>` | Tool implementation. Receives a single argument (the parsed input) |
| `onSuccess`   | `(result) => void`              | Optional callback on success                                   |
| `onError`     | `(error) => void`               | Optional callback on error                                     |

The `handler` takes a **single argument** — the validated input object. There is no second `client` argument.

### JSON Schema config

Same as above, but replace `input` with `inputSchema: InputSchema` and (optionally) `output` with `outputSchema: InputSchema`. The handler receives `Record<string, unknown>` instead of typed args.

### `ToolAnnotations`

```ts
interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}
```

These are the only annotation fields supported. The classic MCP hints (`destructiveHint`, `idempotentHint`, `openWorldHint`) and `annotations.title` are **not** part of the current WebMCP spec — use the top-level `title` field for a display title.

### `exposedTo`

`exposedTo?: string[]` lets you control cross-frame origin visibility. Each entry must be a parseable, potentially-trustworthy origin (e.g. `https://example.com`). Changing `exposedTo` re-registers the tool. Invalid origins cause registration to reject (see below).

### Return value

```tsx
const { state, execute, reset } = useMcpTool({ ... });
```

| Field                  | Type                                  | Description                        |
| ---------------------- | ------------------------------------- | ---------------------------------- |
| `state.isExecuting`    | `boolean`                             | `true` while the handler is running |
| `state.lastResult`     | `CallToolResult \| null`              | Most recent result                 |
| `state.error`          | `Error \| null`                       | Most recent error                  |
| `state.executionCount` | `number`                              | Total successful executions        |
| `execute(input?)`      | `(input?) => Promise<CallToolResult>` | Manually invoke the tool           |
| `reset()`              | `() => void`                          | Reset state to initial values      |

`execute()` (the UI/direct path) throws if validation or handler logic fails. The agent/testing-shim path returns a `CallToolResult` with `isError: true` instead. Both paths update the same reactive state and fire the same `onSuccess`/`onError` callbacks.

## Results: `CallToolResult`

Handlers always return a `CallToolResult` with a `content` array — including error results, which set `isError: true`. This is a deliberate library convention layered over the spec's looser return type, so results bridge cleanly to desktop MCP clients.

```ts
interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
```

`structuredContent` is a library extension for returning structured (machine-readable) output alongside the human-readable `content` blocks.

## Polyfill behavior

When native WebMCP is unavailable, the provider installs a polyfill that exposes:

- `document.modelContext` — the registration API (an `EventTarget`). `registerTool(tool, options?)` returns a `Promise<undefined>` that **rejects** on invalid input (see below). Unregistration is **AbortSignal-only** — pass `{ signal }` and abort it to remove the tool. There is no `unregisterTool`.
- `navigator.modelContextTesting` — the consumer/testing API (`listTools()`, `executeTool(name, argsJson, options?)`, `registerToolsChangedCallback(cb)`, `getCrossDocumentScriptToolResult()`). Browser extensions and tests use this to discover and invoke tools.

The native API is detected by reading `document.modelContext` only; the polyfill marks itself with `__isWebMCPPolyfill` so native support short-circuits installation.

### `toolchange` event

`document.modelContext` is an `EventTarget` that fires a bare `toolchange` event (no `detail`) whenever the set of registered tools changes (register or unregister). Notifications are microtask-batched. Both styles are supported:

```ts
document.modelContext.addEventListener("toolchange", () => { /* ... */ });
// or
document.modelContext.ontoolchange = () => { /* ... */ };
```

### `registerTool` rejection cases

`registerTool` rejects (with a `DOMException` or `TypeError`) when given:

- an empty/missing name, a name longer than 128 chars, or a name not matching `^[A-Za-z0-9_.-]+$`;
- a duplicate name already registered;
- an empty/missing description;
- an `execute` that is not a function;
- a non-serializable `inputSchema`;
- an `exposedTo` entry that is not a parseable, potentially-trustworthy origin.

An already-aborted `AbortSignal` also rejects: `registerTool` rejects with the signal's abort reason and skips registration, matching the WebMCP spec and native Chrome 152+. Validation errors take precedence — the aborted-signal check runs after the checks above.

The hook routes these rejections into `state.error` and fires `onError`, except `AbortError` (lifecycle teardown), which is ignored.
