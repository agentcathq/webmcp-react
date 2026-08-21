# WebMCP AbortSignal threading + consumer API migration — design

**Date:** 2026-08-21
**Status:** Approved (pending final spec review)
**Drivers:** Chrome EPP announcements of 2026-08-18 ("ModelContextTool execute function now
receives AbortSignal") and 2026-08-20 ("RegisteredTool inputSchema type change"), plus the
Chrome 152 removal of `navigator.modelContextTesting` discovered while verifying them.

## Background

Chrome's WebMCP implementation moved under the library in four steps:

| Chrome | Change |
|---|---|
| 152.0.7940.0 | `navigator.modelContextTesting` **removed**. Consumer API is now `document.modelContext.getTools()` / `executeTool(tool, inputArguments, { signal })`. |
| 153.0.8007.0 | Tool `execute` is now always called as `execute(input, { signal })` — `ToolExecuteCallbackOptions { required AbortSignal signal }`, fresh signal per execution. Tool-side abort reason is always a generic `AbortError` DOMException; the caller's custom reason is not forwarded. (Spec PR webmachinelearning/webmcp#247, issue #48.) |
| 153.0.8008.0 | Unregistering a tool no longer cancels in-flight executions; they run to completion and the caller receives the result. (Spec issue #218.) |
| 154.0.8014.0 | `RegisteredTool.inputSchema` returned by `getTools()` changed from a JSON string to a JavaScript object (deep copy of the registered schema). (Spec PR #241.) |

Impact on this repo today:

- `useMcpTool` handlers never see the execution signal, so user code cannot cancel work
  (e.g. `fetch`) when the agent aborts a call.
- The polyfill exposes no `getTools()`/`executeTool()`; its consumer surface is
  `navigator.modelContextTesting`, which native Chrome deleted. On Chrome 152+ the bridge
  extension cannot discover or execute tools at all.
- `extension/src/content-main.ts`, `examples/native-harness`, `examples/playground`
  (DevPanel), and the docs all target `navigator.modelContextTesting`.

Nothing is *broken* by the 153 signal change itself (extra call arguments are ignored in JS),
and the unregister change is favorable to the hook's existing unmount handling. The work is:
thread the signal through, and migrate the consumer surface.

## Scope and PR split

Two PRs:

1. **PR 1 — library (`src/` + docs).** Signal threading in types/hook, polyfill
   `getTools()`/`executeTool()`, shim deprecation, tests, docs. Released as **0.3.0**.
2. **PR 2 — extension + examples.** Migrate to `document.modelContext` with
   `modelContextTesting` fallback, wire end-to-end MCP cancellation, update
   native-harness and playground. No npm release.

## Decisions (with rationale)

- **Abort is cancellation, not error.** When an execution's signal is aborted and the handler
  rejects, the hook decrements in-flight state but does not set `state.error` or fire
  `onError`. Mirrors the existing treatment of `AbortError` from `registerTool` as lifecycle
  teardown; Chrome discards the result anyway.
- **Handlers always get a real `AbortSignal`.** On Chrome ≤152 / bare `execute(args)` calls /
  third-party polyfills, the hook substitutes `new AbortController().signal` (never aborts),
  so user code can pass `signal` to `fetch` unconditionally.
- **Polyfill targets the newest shipped Chrome shape.** `getTools()` returns `inputSchema`
  as a deep-copied object (Chrome 154+/spec), not the ≤153 string. String-vs-object is a
  consumer compat concern, handled at consumption sites.
- **Keep the polyfill's input validation.** Native Chrome does not validate `executeTool`
  input against `inputSchema` (spec issue #92); our polyfill keeps `validateArgs` and its
  `OperationError` for dev-time safety. Documented as stricter-than-native.
- **Deprecate `navigator.modelContextTesting`, keep it one release.** In 0.3.0 the shim
  becomes a thin wrapper over the new engine with a `warnOnce` deprecation; removal targeted
  for 0.4.0. The extension prefers `document.modelContext` and falls back to the shim so
  pages on webmcp-react 0.2.0 keep working.
- **Extension E2E cancellation ships in PR 2**, as its own commits after the migration
  commits, so the migration remains independently revertable.

## §1 Library public API (PR 1)

New exported types in `src/types.ts`:

```ts
export interface ToolExecuteCallbackOptions { signal: AbortSignal }

export interface RegisteredTool {
  name: string;
  title?: string;            // "" default from the polyfill, matching Chrome
  description: string;
  inputSchema?: InputSchema | string;  // object on Chrome 154+/polyfill, string on ≤153
  annotations?: ToolAnnotations;
  window?: Window;
  origin?: string;
}

export interface ModelContextGetToolOptions { fromOrigins?: string[] }
export interface ExecuteToolOptions { signal?: AbortSignal }
```

Changed signatures (additive — one-param functions remain assignable):

- `ToolDescriptor.execute: (input, options: ToolExecuteCallbackOptions) => MaybePromise<CallToolResult>`
- `McpToolConfigZod.handler: (args, ctx: ToolExecuteCallbackOptions) => …`
- `McpToolConfigJsonSchema.handler: (args, ctx: ToolExecuteCallbackOptions) => …`
- `UseMcpToolReturn.execute: (input?, options?: { signal?: AbortSignal }) => Promise<CallToolResult>`

`ModelContext` interface gains:

- `getTools(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>`
- `executeTool(tool: RegisteredTool, inputArguments: string | object, options?: ExecuteToolOptions): Promise<string | null>`

`ModelContextTesting*` types remain with `@deprecated` JSDoc. `index.ts` re-exports the new
types (`ToolExecuteCallbackOptions`, `RegisteredTool`, `ModelContextGetToolOptions`,
`ExecuteToolOptions`); no other public-surface change.

## §2 Hook behavior (`useMcpTool.ts`, PR 1)

Both execution paths share one internal `runHandler(args, signal, { throwOnError })`:

- **Descriptor `execute(args, options?)`** (agent path):
  `const signal = options?.signal ?? new AbortController().signal`; Zod-parse if applicable;
  `handler(validatedArgs, { signal })`. Success path unchanged. Failure with
  `signal.aborted` → cancellation: decrement in-flight, recompute `isExecuting`, leave
  `error`/`lastResult` untouched, skip `onError`, return the usual
  `{ content, isError: true }` result (resolving avoids Chrome's console error for
  post-abort rejections). Failure without abort → unchanged error path.
- **Direct `execute(input?, { signal }?)`** (UI path): same, but failures rethrow as today;
  an aborted-signal failure still rethrows to the caller yet leaves `state.error`/`onError`
  untouched.
- **Unmount/re-register:** unchanged — the hook aborts only the registration signal, never
  execution signals. Under Chrome 153.0.8008+ in-flight executions complete after
  unregistration; `isMountedRef` guards setState. Documented explicitly.
- **Edge (accepted):** a handler that ignores the signal and resolves after abort runs the
  normal success path locally; Chrome ignores the late result.

## §3 Polyfill consumer API (`src/polyfill/`, PR 1)

**New `polyfill/execute.ts`** — single execution engine used by `executeTool` and the shim:

```
runTool(tool: ToolDescriptor, inputArguments: string | object, callerSignal?: AbortSignal): Promise<string>
```

1. Pre-aborted caller signal → reject with `callerSignal.reason`.
2. Parse input: string → `JSON.parse` (failure → `UnknownError`); object → as-is;
   non-object parse result → `UnknownError`.
3. Validate against `tool.inputSchema` via existing `validateArgs` → `OperationError`.
4. Fresh `AbortController` per execution; `tool.execute(parsed, { signal })`.
5. Caller abort mid-flight: abort the controller with the default reason (generic
   `AbortError`, matching Chrome), reject caller with `callerSignal.reason`, ignore late
   settlement (no unhandled rejection).
6. Tool rejects (not aborted) → `UnknownError` with message. Tool resolves → objects
   `JSON.stringify` (throw → `UnknownError`), primitives `String()`, empty string →
   `"Operation succeeded"`.
7. Unregistration mid-flight does not affect the execution (tool captured up front).

**`PolyfillModelContext`** gains:

- `getTools(options?)` → fresh plain objects per call, sorted by name:
  `{ name, title: title ?? "", description, inputSchema: JSON.parse(JSON.stringify(schema)) | undefined,  // JSON round-trip, matching how Chrome materializes the object
  annotations?, window, origin: location.origin }`. `fromOrigins` entries validated
  (`SecurityError` if not potentially trustworthy) but otherwise a no-op — the polyfill is
  same-document only (documented).
- `executeTool(tool, inputArguments, options?)` → lookup by `tool.name`
  (unknown/stale → `UnknownError`), delegate to `runTool`. Returns `Promise<string>`
  (typed `string | null` for native parity).

**Registry:** unchanged except `RegistryInternal.get(name)`.

**`testing-shim.ts`:** thin deprecated wrapper — `listTools()` maps registry tools with
JSON-string `inputSchema` (its historical shape); `executeTool(name, json, opts)` finds the
tool and calls `runTool`; first use fires a `warnOnce` deprecation pointing at
`document.modelContext.getTools()/executeTool()`. Still installed on
`navigator.modelContextTesting` in 0.3.0; removal in 0.4.0.

**Not doing:** `toolactivated`/`toolcancel` window events (Chromium-only, unspecced, no
consumer), cross-frame discovery, `exposedTo` filtering in `getTools` (single-document
polyfill — every registered tool is same-origin by construction).

## §4 Extension + examples (PR 2)

**`content-main.ts` — `PageToolApi` adapter,** selected at detection time (polling retained;
each tick prefers modelContext):

- **modelContext adapter** (native Chrome 150+ or 0.3.0 polyfill; detected via
  `typeof document.modelContext?.getTools === "function"`):
  `list()` = `getTools()` → `BrowserTool[]`, normalizing `inputSchema` with
  `typeof s === "string" ? s : JSON.stringify(s)` (string on ≤153, object on 154+).
  `execute(name, argsJson, signal)` = `getTools()` → find by name →
  `executeTool(tool, argsJson, { signal })`; on `TypeError` (future object-only Chrome),
  retry once with `JSON.parse(argsJson)`. `onChange` = `toolchange` listener.
- **modelContextTesting adapter** — fallback for 0.2.0 pages / Chrome ≤151; as today plus
  `{ signal }` (the 0.2.0 shim honors it).

**Cancellation plumbing** — new `CANCEL_TOOL { requestId }` message per hop, mirroring the
`EXECUTE_TOOL` family:

1. `mcp-server/index.ts`: pass the MCP SDK's `extra.signal` into
   `registry.callTool(name, args, signal)`.
2. `tool-registry.ts`: on abort → send WS `CANCEL_TOOL`, drop the pending entry, reject with
   `AbortError`.
3. `background.ts`: `CANCEL_TOOL` → resolve pending request's tab →
   `chrome.tabs.sendMessage(tabId, { type: "CANCEL_TOOL", requestId })`.
4. `content-isolated.ts` → `postMessage({ type: "WEBMCP_CANCEL_TOOL", requestId })`.
5. `content-main.ts`: `Map<requestId, AbortController>`; cancel → `abort()`. The resulting
   error still posts `WEBMCP_TOOL_RESULT`, dropped upstream because the requestId is no
   longer pending (verify "unknown requestId → ignore" exists at each hop; add if missing).

**`extension/src/types.ts`:** add the `*CancelTool*` message types; add local
`ModelContext`/`RegisteredTool` declarations (extension keeps standalone declarations, as
today); mark `ModelContextTesting` deprecated.

**Examples:**

- `native-harness/App.tsx`: probes move to `document.modelContext.getTools()/executeTool()`;
  add probes for (a) handler receives an `AbortSignal`, (b) caller abort → handler signal
  aborts with `AbortError` and caller rejects with the caller's reason, (c) unregister
  mid-flight → still resolves (153.0.8008+), (d) `inputSchema` string-or-object handling.
- `playground/DevPanel.tsx`: `getTools()/executeTool()`; Cancel button while in flight; add
  a `slow_hint` demo tool (~3s, honors `signal`) so cancellation is demonstrable.
- `extension/README.md`, `PRIVACY.md`: modelContextTesting → document.modelContext.

## §5 Testing, docs, versioning

**Tests (PR 1)** — existing `__tests__` layout, StrictMode-compatible:

- Hook: real `AbortSignal` on both paths; bare `execute(args)` (Chrome ≤152 shape) yields a
  non-aborting signal; caller abort → handler signal `AbortError`, caller sees caller's
  reason, `state.error` null, no `onError`; non-abort failures unchanged; registration-signal
  abort does not abort execution signals.
- Polyfill: `getTools()` sorted / fresh objects / deep-copied object `inputSchema` /
  `title: ""` default / `fromOrigins` validation; `executeTool()` serialization matrix
  (object → JSON, primitives, empty string → "Operation succeeded"), unknown tool →
  `UnknownError`, invalid JSON → `UnknownError`, schema violation → `OperationError`,
  pre-aborted → `signal.reason`, mid-flight abort (tool signal aborts, caller rejects, late
  settlement ignored), unregister mid-flight → resolves.
- Shim: existing tests pass except two error-shape updates (pre-aborted and mid-flight abort
  now reject with `signal.reason`), updated with comments citing Chrome 152+; deprecation
  `warnOnce` fires once.
- Types: compile-time check that one-arg handlers still typecheck.

**Extension verification (PR 2):** no test harness exists in `extension/`; verified via the
native-harness probes against Chrome canary and the polyfill, documented in the PR. Adding a
test framework to `extension/` is out of scope.

**Docs:** README (0.3.0 changes section: handler second arg, consumer API, deprecation),
docs/api.md (getTools/executeTool section + Chrome compat table: ≤152 no tool signal / 153
signal / 154 object `inputSchema`), AGENTS.md ("Single-arg execute/handler" → two-arg;
consumer-API note), skills, CHANGELOG (per-PR entries).

**Versioning:** 0.3.0 cut after PR 1. `navigator.modelContextTesting` deprecated in 0.3.0,
removed in 0.4.0.

## Risks

- **Chrome may flip `executeTool` input to object-only** (open CL). Mitigated: adapter
  retries with a parsed object on `TypeError`; polyfill accepts both already.
- **Spec/Chromium drift** (spec PR #247 unmerged; event names unsettled). Mitigated: we track
  shipped Chrome behavior and note spec status in docs; events deliberately not implemented.
- **Silent breakage for 0.2.0 pages with the new extension** if the fallback path regresses —
  covered by keeping the modelContextTesting adapter until 0.4.0.
