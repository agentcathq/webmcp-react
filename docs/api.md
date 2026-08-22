# API Reference

This library targets the current [WebMCP](https://github.com/webmachinelearning/webmcp) spec. Both the registration and consumer APIs live on `document.modelContext` (an `EventTarget`): `registerTool` on the registration side, `getTools()`/`executeTool()` on the consumer side. `navigator.modelContextTesting` is a deprecated wrapper over the same consumer engine.

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
| `handler`     | `(args, ctx) => CallToolResult \| Promise<CallToolResult>` | Tool implementation. Receives the parsed input and `ctx: { signal: AbortSignal }`; the signal aborts when the agent cancels the execution (Chrome 153+; otherwise a never-aborting substitute) |
| `onSuccess`   | `(result) => void`              | Optional callback on success                                   |
| `onError`     | `(error) => void`               | Optional callback on error                                     |

The `handler` receives the validated input object and a second `ctx` argument containing the execution `AbortSignal`. Handlers that declare a single parameter keep working.

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
| `execute(input?, { signal }?)` | `(input?, options?) => Promise<CallToolResult>` | Manually invoke the tool  |
| `reset()`              | `() => void`                          | Reset state to initial values      |

`execute()` (the UI/direct path) throws if validation or handler logic fails. The agent/testing-shim path returns a `CallToolResult` with `isError: true` instead. Both paths update the same reactive state and fire the same `onSuccess`/`onError` callbacks.

### Cancellation

Each execution gets its own `AbortSignal`, passed to the handler as `ctx.signal`. On
Chrome 153.0.8007.0+ (and via the polyfill's `executeTool`) it aborts when the caller
cancels. When an aborted execution's handler rejects, the hook treats it as
**cancellation**: `isExecuting` clears, but `state.error` stays untouched and `onError`
does not fire. Unregistering a tool (unmount) does **not** cancel in-flight executions
(Chrome 153.0.8008.0+ behavior).

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
- `document.modelContext.getTools(options?)` / `executeTool(tool, inputArguments, options?)`
  — the consumer API (same shape as native Chrome). `getTools()` resolves sorted, fresh
  `RegisteredTool` objects whose `inputSchema` is a deep-copied **object**;
  `executeTool` accepts a JSON string or object input, forwards `options.signal` into the
  tool's execution signal, rejects `UnknownError` on failure, and — unlike native Chrome —
  validates input against `inputSchema` (`OperationError`).
- `navigator.modelContextTesting` — **deprecated** wrapper over the same engine
  (`listTools()` keeps returning a JSON-string `inputSchema`); removed in 0.4.0.

| Chrome | Behavior this library tracks |
| --- | --- |
| ≤152 | `execute(input)` — no tool-side signal (the library substitutes one); `navigator.modelContextTesting` removed in 152.0.7940.0 |
| 153 | `execute(input, { signal })`; unregistration no longer cancels in-flight executions (153.0.8008.0+) |
| 154 | `RegisteredTool.inputSchema` is an object (was a JSON string) |

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
