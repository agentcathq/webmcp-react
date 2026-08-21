# WebMCP AbortSignal Threading + Consumer API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread the Chrome 153 execution `AbortSignal` through to `useMcpTool` handlers, add the Chrome 152+ consumer API (`document.modelContext.getTools()`/`executeTool()`) to the polyfill, and migrate the bridge extension + examples off the removed `navigator.modelContextTesting` — with end-to-end MCP cancellation.

**Architecture:** Two PRs. PR 1 (Tasks 1–6) touches only `src/` + docs and ships as webmcp-react 0.3.0: new types, hook signal threading with abort-as-cancellation semantics, a single execution engine (`src/polyfill/execute.ts`) used by both the new `document.modelContext.executeTool()` and the now-deprecated testing shim. PR 2 (Tasks 7–11) migrates `extension/` and `examples/` to the consumer API behind a small `PageToolApi` adapter (with a `modelContextTesting` fallback for 0.2.0 pages) and wires a `CANCEL_TOOL` message through all four hops (MCP SDK → WebSocket → background → content scripts → page).

**Tech Stack:** TypeScript, React 18/19, Zod, Vitest + React Testing Library + jsdom, Biome, tsup, pnpm workspaces, Chrome extension MV3, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-08-21-webmcp-signal-and-consumer-api-design.md` (approved). Read it before starting.

## Global Constraints

- Package manager is **pnpm**. Full check before each PR: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
- Biome pre-commit hook auto-formats staged files; never hand-tune formatting — run `pnpm lint:fix` if needed.
- **No new dependencies** anywhere (AGENTS.md boundary).
- **Never delete or weaken existing tests.** Where shipped-Chrome behavior changed an error shape, update the assertion, keep the test's intent, and add a comment citing the Chrome version (e.g. "Chrome 152+ rejects with signal.reason").
- **Both execution paths stay mirrored** (AGENTS.md): direct `execute()` and the agent path must share behavior via a single code path.
- All `src/` tests must pass under React StrictMode (double-mount).
- Do NOT add `"use client"` to source files (added at build time by tsup).
- Error names match shipped Chrome: execution failures reject `UnknownError`; polyfill-only schema validation keeps `OperationError`; unknown tool via shim keeps `NotFoundError`; unknown tool via `executeTool` uses `UnknownError`.
- Version: PR 1 bumps `package.json` to **0.3.0**. `navigator.modelContextTesting` is deprecated in 0.3.0 and removed in 0.4.0 (do NOT remove it now).
- Handlers must **always** receive a real `AbortSignal`: substitute `new AbortController().signal` when the caller provides none (Chrome ≤152, bare `execute(args)`, third-party polyfills).
- Abort semantics: when an execution's signal is aborted and the handler rejects, that is **cancellation** — decrement in-flight state, do NOT set `state.error`, do NOT fire `onError`.
- Branches/PRs: PR 1 = current branch `kashish/package-email-support-922aa3` → `main`. PR 2 = branch `kashish/webmcp-extension-modelcontext` created from PR 1's head, PR based on PR 1's branch (retarget to `main` after PR 1 merges).
- Commit messages follow existing history style: `feat: …`, `docs: …`, `chore: …`, `test: …`.

---

## PR 1 — Library (`src/` + docs), ships as 0.3.0

### Task 1: Types — `ToolExecuteCallbackOptions`, `RegisteredTool`, consumer-API surface

**Files:**
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/type-compat.test.ts` (create)

**Interfaces:**
- Consumes: existing `InputSchema`, `ToolAnnotations`, `CallToolResult`, `MaybePromise` from `src/types.ts`.
- Produces (later tasks rely on these exact names):
  - `ToolExecuteCallbackOptions { signal: AbortSignal }`
  - `ExecuteToolOptions { signal?: AbortSignal }`
  - `RegisteredTool { name: string; title?: string; description: string; inputSchema?: InputSchema | string; annotations?: ToolAnnotations; window?: Window; origin?: string }`
  - `ModelContextGetToolOptions { fromOrigins?: string[] }`
  - `ToolDescriptor.execute(input: TArgs, options: ToolExecuteCallbackOptions): MaybePromise<CallToolResult>`
  - `handler(args, ctx: ToolExecuteCallbackOptions)` on both config types
  - `UseMcpToolReturn.execute(input?: Record<string, unknown>, options?: ExecuteToolOptions): Promise<TResult>`
  - `ModelContext.getTools?(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>`
  - `ModelContext.executeTool?(tool: RegisteredTool, inputArguments: string | object, options?: ExecuteToolOptions): Promise<string | null>`

- [ ] **Step 1: Write the failing type-compat test**

Create `src/__tests__/type-compat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ExecuteToolOptions,
  McpToolConfigJsonSchema,
  McpToolConfigZod,
  RegisteredTool,
  ToolExecuteCallbackOptions,
} from "../types";

// Compile-time assertions. One-argument handlers must remain assignable after
// the handler signature gains a second (ctx) parameter, and the new consumer
// API types must accept both the Chrome ≤153 (string) and 154+ (object)
// inputSchema shapes.

const oneArgJson: McpToolConfigJsonSchema = {
  name: "one_arg",
  description: "legacy single-arg handler",
  handler: async (args) => ({
    content: [{ type: "text", text: String(Object.keys(args).length) }],
  }),
};

const twoArgJson: McpToolConfigJsonSchema = {
  name: "two_arg",
  description: "signal-aware handler",
  handler: async (_args, ctx: ToolExecuteCallbackOptions) => {
    ctx.signal.throwIfAborted();
    return { content: [{ type: "text", text: "ok" }] };
  },
};

const oneArgZod: McpToolConfigZod<{ q: z.ZodString }> = {
  name: "zod_one",
  description: "legacy single-arg zod handler",
  input: z.object({ q: z.string() }),
  handler: async ({ q }) => ({ content: [{ type: "text", text: q }] }),
};

const twoArgZod: McpToolConfigZod<{ q: z.ZodString }> = {
  name: "zod_two",
  description: "signal-aware zod handler",
  input: z.object({ q: z.string() }),
  handler: async ({ q }, { signal }) => {
    signal.throwIfAborted();
    return { content: [{ type: "text", text: q }] };
  },
};

const objectSchema: RegisteredTool = {
  name: "t1",
  description: "d",
  inputSchema: { type: "object", properties: {} },
};

const stringSchema: RegisteredTool = {
  name: "t2",
  description: "d",
  inputSchema: '{"type":"object"}',
};

const opts: ExecuteToolOptions = { signal: new AbortController().signal };

describe("type compatibility", () => {
  it("compiles", () => {
    expect([oneArgJson, twoArgJson, oneArgZod, twoArgZod, objectSchema, stringSchema, opts]).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm typecheck`
Expected: FAIL — `ToolExecuteCallbackOptions`, `RegisteredTool`, `ExecuteToolOptions` are not exported from `../types`, and the two-arg handlers don't match the current one-arg handler types.

- [ ] **Step 3: Update `src/types.ts`**

Add after the `MaybePromise` definition (near the top):

```ts
/** Second argument to a tool's execute callback / useMcpTool handler (Chrome 153+ shape). */
export interface ToolExecuteCallbackOptions {
  signal: AbortSignal;
}

/** Options for ModelContext.executeTool and UseMcpToolReturn.execute. */
export interface ExecuteToolOptions {
  signal?: AbortSignal;
}
```

Change `ToolDescriptor.execute` (currently `execute: (input: TArgs) => MaybePromise<CallToolResult>;`):

```ts
  execute: (input: TArgs, options: ToolExecuteCallbackOptions) => MaybePromise<CallToolResult>;
```

Change the two handler signatures:

```ts
// In McpToolConfigZod:
  handler: (
    args: z.infer<z.ZodObject<T>>,
    ctx: ToolExecuteCallbackOptions,
  ) => MaybePromise<CallToolResult>;

// In McpToolConfigJsonSchema:
  handler: (
    args: Record<string, unknown>,
    ctx: ToolExecuteCallbackOptions,
  ) => MaybePromise<CallToolResult>;
```

Change `UseMcpToolReturn.execute`:

```ts
  execute: (input?: Record<string, unknown>, options?: ExecuteToolOptions) => Promise<TResult>;
```

Add before the `ModelContext` interface:

```ts
/**
 * Tool metadata returned by ModelContext.getTools().
 * `inputSchema` is an object on Chrome 154+ and this library's polyfill, but a
 * JSON string on Chrome ≤153 — consumers must handle both:
 * `typeof s === "string" ? JSON.parse(s) : s`.
 */
export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: InputSchema | string;
  annotations?: ToolAnnotations;
  window?: Window;
  origin?: string;
}

export interface ModelContextGetToolOptions {
  fromOrigins?: string[];
}
```

Add to the `ModelContext` interface body (after `registerTool`). Optional because native Chrome ≤149 and third-party polyfills expose `registerTool` without the consumer API:

```ts
  getTools?(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]>;
  executeTool?(
    tool: RegisteredTool,
    inputArguments: string | object,
    options?: ExecuteToolOptions,
  ): Promise<string | null>;
```

Add `@deprecated` JSDoc to the three testing types (keep them intact otherwise):

```ts
/** @deprecated Removed from native Chrome in 152; use ModelContext.getTools()/executeTool(). Will be removed in webmcp-react 0.4.0. */
export interface ModelContextTestingToolInfo { ... }

/** @deprecated Removed from native Chrome in 152. Will be removed in webmcp-react 0.4.0. */
export interface ModelContextTestingExecuteToolOptions { ... }

/** @deprecated Removed from native Chrome in 152; use document.modelContext.getTools()/executeTool(). Will be removed in webmcp-react 0.4.0. */
export interface ModelContextTesting { ... }
```

- [ ] **Step 4: Export the new types from `src/index.ts`**

Add to the existing `export type` block: `ExecuteToolOptions`, `ModelContextGetToolOptions`, `RegisteredTool`, `ToolExecuteCallbackOptions` (keep alphabetical order within the block).

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- src/__tests__/type-compat.test.ts`
Expected: typecheck PASS (the hook still compiles because one-arg implementations are assignable to two-arg types); type-compat test PASS. If `pnpm typecheck` reports errors in `src/hooks/useMcpTool.ts` about `execute`, they are pre-existing-arity related and must NOT appear — the descriptor's inline `execute` has fewer params than the type requires, which TypeScript allows. Any other error: fix before proceeding.

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `pnpm test`
Expected: PASS (types-only change).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/index.ts src/__tests__/type-compat.test.ts
git commit -m "feat: add ToolExecuteCallbackOptions, RegisteredTool, and consumer-API types"
```

---

### Task 2: Hook — thread the execution signal, abort-as-cancellation

**Files:**
- Modify: `src/hooks/useMcpTool.ts`
- Test: `src/hooks/__tests__/useMcpTool.test.tsx` (append a new describe block)

**Interfaces:**
- Consumes: `ToolExecuteCallbackOptions`, `ExecuteToolOptions` from Task 1.
- Produces: `useMcpTool(...).execute(input?, options?)` accepting a caller signal; descriptor `execute(args, options?)` forwarding `options?.signal ?? new AbortController().signal` to `handler(args, { signal })`. Internal helper name: `runHandler` (not exported).

- [ ] **Step 1: Write the failing tests**

Append to `src/hooks/__tests__/useMcpTool.test.tsx` (uses the file's existing helpers: `renderWithProvider`, `ToolComponent`, `waitForRegistration`, `OK_RESULT`, `ExecuteFn`; add `ToolDescriptor` and `CallToolResult` to the existing type-only import from `../../types` if not present):

```tsx
// ─── Execution signal (Chrome 153+ shape) ────────────────────────

describe("execution signal", () => {
  function installFakeNative() {
    const captured: ToolDescriptor[] = [];
    const fake = {
      registerTool: (tool: ToolDescriptor) => {
        captured.push(tool);
        return Promise.resolve(undefined);
      },
    };
    Object.defineProperty(document, "modelContext", { value: fake, configurable: true });
    return {
      captured,
      uninstall: () => {
        delete (document as { modelContext?: unknown }).modelContext;
      },
    };
  }

  it("direct execute() passes a non-aborted AbortSignal to the handler", async () => {
    const seen: Array<{ signal: AbortSignal }> = [];
    const executeRef = { current: null as ExecuteFn | null };
    renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_direct",
          description: "d",
          handler: async (_args, ctx) => {
            seen.push(ctx);
            return OK_RESULT;
          },
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    await act(async () => {
      await executeRef.current?.();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].signal.aborted).toBe(false);
  });

  it("direct execute() forwards a caller-provided signal", async () => {
    let received: AbortSignal | undefined;
    const executeRef = { current: null as ExecuteFn | null };
    renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_forward",
          description: "d",
          handler: async (_args, { signal }) => {
            received = signal;
            return OK_RESULT;
          },
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    const controller = new AbortController();
    await act(async () => {
      await executeRef.current?.({}, { signal: controller.signal });
    });
    expect(received).toBe(controller.signal);
  });

  it("aborted execution is cancellation: rethrows but no state.error, no onError", async () => {
    const onError = vi.fn();
    const executeRef = { current: null as ExecuteFn | null };
    const { getByTestId } = renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_cancel",
          description: "d",
          onError,
          handler: (_args, { signal }) =>
            new Promise<CallToolResult>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    const controller = new AbortController();
    let rejected: unknown = null;
    let promise!: Promise<CallToolResult>;
    act(() => {
      promise = executeRef.current!({}, { signal: controller.signal });
      promise.catch((e: unknown) => {
        rejected = e;
      });
    });
    await act(async () => {
      controller.abort(new DOMException("user cancelled", "AbortError"));
      await promise.catch(() => {});
    });
    expect((rejected as { name?: string })?.name).toBe("AbortError");
    expect(onError).not.toHaveBeenCalled();
    expect(getByTestId("error").textContent).toBe("none");
    expect(getByTestId("executing").textContent).toBe("no");
  });

  it("descriptor execute forwards Chrome's signal and treats abort as cancellation", async () => {
    const { captured, uninstall } = installFakeNative();
    try {
      const onError = vi.fn();
      const { getByTestId } = renderWithProvider(
        <ToolComponent
          config={{
            name: "sig_native",
            description: "d",
            onError,
            handler: (_args, { signal }) =>
              new Promise<CallToolResult>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          }}
        />,
      );
      await waitFor(() => expect(captured.length).toBeGreaterThan(0));
      const controller = new AbortController();
      let result!: Promise<CallToolResult>;
      act(() => {
        result = Promise.resolve(captured[0].execute({}, { signal: controller.signal }));
      });
      let settled: CallToolResult | undefined;
      await act(async () => {
        controller.abort();
        settled = await result;
      });
      // Agent path resolves with an isError result rather than rejecting
      // (Chrome discards it; rejecting would log a console error in Chrome).
      expect(settled?.isError).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(getByTestId("error").textContent).toBe("none");
    } finally {
      uninstall();
    }
  });

  it("bare descriptor execute (Chrome ≤152 shape) still provides a real signal", async () => {
    const { captured, uninstall } = installFakeNative();
    try {
      let ctxSeen: { signal: AbortSignal } | undefined;
      renderWithProvider(
        <ToolComponent
          config={{
            name: "sig_bare",
            description: "d",
            handler: async (_args, ctx) => {
              ctxSeen = ctx;
              return OK_RESULT;
            },
          }}
        />,
      );
      await waitFor(() => expect(captured.length).toBeGreaterThan(0));
      await act(async () => {
        // Chrome ≤152 calls execute with a single argument.
        await (captured[0].execute as unknown as (input: Record<string, unknown>) => unknown)({});
      });
      expect(ctxSeen?.signal).toBeInstanceOf(AbortSignal);
      expect(ctxSeen?.signal.aborted).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("non-abort failures still set state.error and fire onError", async () => {
    const onError = vi.fn();
    const executeRef = { current: null as ExecuteFn | null };
    const { getByTestId } = renderWithProvider(
      <ToolComponent
        config={{
          name: "sig_realfail",
          description: "d",
          onError,
          handler: async () => {
            throw new Error("genuine failure");
          },
        }}
        onExecuteRef={executeRef}
      />,
    );
    await waitForRegistration();
    const controller = new AbortController(); // present but never aborted
    await act(async () => {
      await executeRef.current!({}, { signal: controller.signal }).catch(() => {});
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getByTestId("error").textContent).toBe("genuine failure");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/hooks/__tests__/useMcpTool.test.tsx`
Expected: the new "execution signal" tests FAIL (handler receives `undefined` ctx / cancellation still sets error). All pre-existing tests still PASS.

- [ ] **Step 3: Implement in `src/hooks/useMcpTool.ts`**

Add `ExecuteToolOptions` and `ToolExecuteCallbackOptions` to the type-only import from `../types`.

Replace the body of the `execute` useCallback and the descriptor's inline `execute` with one shared runner. Insert this above the existing `execute` definition (after the mount-tracking `useEffect`):

```ts
  const runHandler = useCallback(
    async (
      input: Record<string, unknown>,
      signal: AbortSignal,
      opts: { throwOnError: boolean },
    ): Promise<CallToolResult> => {
      inFlightCountRef.current++;
      if (isMountedRef.current) {
        setState((prev) => ({ ...prev, isExecuting: true, error: null }));
      }

      try {
        let validatedInput = input;
        const currentConfig = configRef.current;
        const currentIsZod = "input" in currentConfig && currentConfig.input instanceof z.ZodObject;

        if (currentIsZod) {
          validatedInput = (currentConfig as McpToolConfigZod<z.ZodRawShape>).input.parse(input);
        }

        const result = await handlerRef.current(validatedInput, { signal });

        inFlightCountRef.current--;
        if (isMountedRef.current) {
          setState((prev) => ({
            isExecuting: inFlightCountRef.current > 0,
            lastResult: result,
            error: null,
            executionCount: prev.executionCount + 1,
          }));
        }

        onSuccessRef.current?.(result);
        return result;
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        inFlightCountRef.current--;

        if (signal.aborted) {
          // Cancellation, not error: the agent/user aborted this execution.
          // Leave error/lastResult untouched and skip onError.
          if (isMountedRef.current) {
            setState((prev) => ({ ...prev, isExecuting: inFlightCountRef.current > 0 }));
          }
        } else {
          if (isMountedRef.current) {
            setState((prev) => ({
              ...prev,
              isExecuting: inFlightCountRef.current > 0,
              error,
            }));
          }
          onErrorRef.current?.(error);
        }

        if (opts.throwOnError) throw error;
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    [],
  );
```

Replace the existing `execute` useCallback with:

```ts
  const execute = useCallback(
    (input?: Record<string, unknown>, options?: ExecuteToolOptions): Promise<CallToolResult> =>
      runHandler(input ?? {}, options?.signal ?? new AbortController().signal, {
        throwOnError: true,
      }),
    [runHandler],
  );
```

Replace the descriptor's entire inline `execute` property (the ~50-line async function at the bottom of the descriptor literal) with:

```ts
      execute: (args: Record<string, unknown>, options?: ToolExecuteCallbackOptions) =>
        runHandler(args, options?.signal ?? new AbortController().signal, {
          throwOnError: false,
        }),
```

Delete nothing else — registration, ownership tokens, and error routing stay as they are.

- [ ] **Step 4: Run the hook tests**

Run: `pnpm test -- src/hooks/__tests__/useMcpTool.test.tsx`
Expected: PASS, including all pre-existing tests (the refactor must not change non-abort behavior: state-update ordering is setState before `onSuccess`/`onError`, in-flight counting is unchanged).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (smoke/integration tests exercise the shim path, which still calls `execute(parsed)` one-arg until Task 5 — the substitute signal covers it).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMcpTool.ts src/hooks/__tests__/useMcpTool.test.tsx
git commit -m "feat: thread execution AbortSignal to handlers; treat abort as cancellation"
```

---

### Task 3: Polyfill execution engine (`src/polyfill/execute.ts`)

**Files:**
- Create: `src/polyfill/execute.ts`
- Test: `src/polyfill/__tests__/execute.test.ts` (create)

**Interfaces:**
- Consumes: `ToolDescriptor` (with Task 1's two-arg `execute`), `validateArgs` from `./validation`.
- Produces: `runTool(tool: ToolDescriptor, inputArguments: string | object, callerSignal?: AbortSignal): Promise<string>` — used by Task 4's `executeTool` and Task 5's shim.

- [ ] **Step 1: Write the failing tests**

Create `src/polyfill/__tests__/execute.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, ToolDescriptor } from "../../types";
import { runTool } from "../execute";

function makeTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: "engine_tool",
    description: "engine test tool",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

const OK: CallToolResult = { content: [{ type: "text", text: "ok" }] };

describe("runTool", () => {
  it("passes parsed args and a fresh non-aborted signal to execute", async () => {
    const execute = vi.fn(
      async (_input: Record<string, unknown>, options: { signal: AbortSignal }) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal.aborted).toBe(false);
        return OK;
      },
    );
    await runTool(makeTool({ execute }), '{"query":"hi"}');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ query: "hi" });
  });

  it("accepts an object input without re-parsing", async () => {
    const execute = vi.fn(async () => OK);
    await runTool(makeTool({ execute }), { query: "hi" });
    expect(execute.mock.calls[0][0]).toEqual({ query: "hi" });
  });

  it("gives each execution an independent signal", async () => {
    const signals: AbortSignal[] = [];
    const tool = makeTool({
      inputSchema: undefined,
      execute: async (_i, { signal }) => {
        signals.push(signal);
        return OK;
      },
    });
    await runTool(tool, "{}");
    await runTool(tool, "{}");
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("serializes object results to JSON", async () => {
    const raw = await runTool(makeTool(), '{"query":"x"}');
    expect(JSON.parse(raw)).toEqual(OK);
  });

  it("stringifies primitive results and maps empty string to 'Operation succeeded'", async () => {
    // Non-CallToolResult returns exercise native-parity serialization.
    const num = makeTool({ inputSchema: undefined, execute: () => 42 as unknown as CallToolResult });
    expect(await runTool(num, "{}")).toBe("42");
    const empty = makeTool({ inputSchema: undefined, execute: () => "" as unknown as CallToolResult });
    expect(await runTool(empty, "{}")).toBe("Operation succeeded");
  });

  it("rejects UnknownError for a non-serializable (circular) result", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const tool = makeTool({
      inputSchema: undefined,
      execute: () => circular as unknown as CallToolResult,
    });
    await expect(runTool(tool, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects UnknownError on invalid JSON string input", async () => {
    await expect(runTool(makeTool(), "not json")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects UnknownError on non-object JSON input", async () => {
    await expect(runTool(makeTool(), '"a string"')).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("rejects OperationError on schema violation (polyfill-only validation)", async () => {
    await expect(runTool(makeTool(), "{}")).rejects.toThrow(
      expect.objectContaining({ name: "OperationError", message: 'Missing required field: "query"' }),
    );
  });

  it("rejects with the exact reason for a pre-aborted caller signal", async () => {
    const reason = new DOMException("pre-cancelled", "AbortError");
    await expect(
      runTool(makeTool(), '{"query":"x"}', AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
  });

  it("mid-flight abort: caller gets caller's reason, tool gets a generic AbortError", async () => {
    const controller = new AbortController();
    let toolReason: unknown;
    const tool = makeTool({
      inputSchema: undefined,
      execute: (_i, { signal }) =>
        new Promise<CallToolResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              toolReason = signal.reason;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const callerReason = new Error("custom cancellation reason");
    const promise = runTool(tool, "{}", controller.signal);
    controller.abort(callerReason);
    await expect(promise).rejects.toBe(callerReason);
    // Chrome 153: the tool-side signal always aborts with a generic AbortError,
    // never the caller's custom reason.
    expect((toolReason as { name?: string })?.name).toBe("AbortError");
    expect(toolReason).not.toBe(callerReason);
  });

  it("ignores late settlement after abort (no unhandled rejection, result stays rejected)", async () => {
    const controller = new AbortController();
    let resolveTool!: (r: CallToolResult) => void;
    const tool = makeTool({
      inputSchema: undefined,
      execute: () =>
        new Promise<CallToolResult>((resolve) => {
          resolveTool = resolve;
        }),
    });
    const promise = runTool(tool, "{}", controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    resolveTool(OK); // late — must be silently ignored
    await new Promise((r) => setTimeout(r, 0));
  });

  it("swallows late rejection after abort (no unhandled rejection)", async () => {
    const controller = new AbortController();
    let rejectTool!: (e: unknown) => void;
    const tool = makeTool({
      inputSchema: undefined,
      execute: () =>
        new Promise<CallToolResult>((_resolve, reject) => {
          rejectTool = reject;
        }),
    });
    const promise = runTool(tool, "{}", controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    rejectTool(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));
  });

  it("rejects UnknownError (message preserved) when the tool fails without abort", async () => {
    const tool = makeTool({
      inputSchema: undefined,
      execute: () => {
        throw new Error("handler broke");
      },
    });
    await expect(runTool(tool, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
    await expect(runTool(tool, "{}")).rejects.toThrow("handler broke");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/polyfill/__tests__/execute.test.ts`
Expected: FAIL — `../execute` module does not exist.

- [ ] **Step 3: Implement `src/polyfill/execute.ts`**

```ts
import type { ToolDescriptor } from "../types";
import { validateArgs } from "./validation";

function serializeResult(result: unknown): string {
  const text =
    typeof result === "object" && result !== null
      ? JSON.stringify(result) // throws on cycles — handled by the caller
      : String(result);
  return text === "" ? "Operation succeeded" : text;
}

/**
 * Execute a registered tool the way native Chrome does (152–154 behavior):
 * JSON-string or object input, per-execution AbortSignal forwarded to the
 * tool, caller abort rejects with the caller signal's reason while the
 * tool-side signal aborts with a generic AbortError, late settlement after
 * abort is ignored, and results serialize to a string (objects via JSON,
 * primitives via String, empty string → "Operation succeeded").
 *
 * Deviation from native: input is validated against the tool's inputSchema
 * (OperationError) — Chrome does not validate yet (spec issue #92).
 */
export function runTool(
  tool: ToolDescriptor,
  inputArguments: string | object,
  callerSignal?: AbortSignal,
): Promise<string> {
  if (callerSignal?.aborted) {
    return Promise.reject(callerSignal.reason);
  }

  let parsed: unknown;
  if (typeof inputArguments === "string") {
    try {
      parsed = JSON.parse(inputArguments);
    } catch {
      return Promise.reject(new DOMException("Failed to parse input arguments", "UnknownError"));
    }
  } else {
    parsed = inputArguments;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return Promise.reject(
      new DOMException("Input arguments must be a JSON object", "UnknownError"),
    );
  }

  if (tool.inputSchema) {
    try {
      validateArgs(parsed as Record<string, unknown>, tool.inputSchema);
    } catch (thrown) {
      return Promise.reject(thrown);
    }
  }

  const controller = new AbortController();

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      controller.abort(); // default reason → generic AbortError, matching Chrome
      reject(callerSignal?.reason);
    };
    callerSignal?.addEventListener("abort", onAbort, { once: true });

    Promise.resolve()
      .then(() => tool.execute(parsed as Record<string, unknown>, { signal: controller.signal }))
      .then(
        (result) => {
          if (settled) return; // late settlement after abort — ignored
          settled = true;
          callerSignal?.removeEventListener("abort", onAbort);
          try {
            resolve(serializeResult(result));
          } catch {
            reject(new DOMException("Tool result is not JSON-serializable", "UnknownError"));
          }
        },
        (thrown: unknown) => {
          if (settled) return; // late rejection after abort — ignored
          settled = true;
          callerSignal?.removeEventListener("abort", onAbort);
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          reject(new DOMException(`Tool execution failed: ${message}`, "UnknownError"));
        },
      );
  });
}
```

- [ ] **Step 4: Run the engine tests**

Run: `pnpm test -- src/polyfill/__tests__/execute.test.ts`
Expected: PASS (all 15).

- [ ] **Step 5: Commit**

```bash
git add src/polyfill/execute.ts src/polyfill/__tests__/execute.test.ts
git commit -m "feat: add polyfill execution engine with per-execution AbortSignal"
```

---

### Task 4: Polyfill `getTools()` / `executeTool()`

**Files:**
- Modify: `src/polyfill/registry.ts` (add `get`)
- Modify: `src/polyfill/index.ts` (PolyfillModelContext gains the consumer API)
- Test: `src/polyfill/__tests__/consumer-api.test.ts` (create)

**Interfaces:**
- Consumes: `runTool` (Task 3), `isPotentiallyTrustworthyOrigin` from `./validation`, types from Task 1.
- Produces: `RegistryInternal.get(name: string): ToolDescriptor | undefined`; `document.modelContext.getTools(options?)` and `.executeTool(tool, inputArguments, options?)` on the installed polyfill (Task 5's shim and PR 2's adapter rely on these).

- [ ] **Step 1: Write the failing tests**

Create `src/polyfill/__tests__/consumer-api.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult, ModelContext, RegisteredTool, ToolDescriptor } from "../../types";
import { cleanupPolyfill, installPolyfill } from "..";

function makeTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: "consumer_tool",
    description: "consumer test tool",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

function mc(): ModelContext {
  const m = document.modelContext;
  if (!m) throw new Error("polyfill not installed");
  return m;
}

afterEach(() => {
  cleanupPolyfill();
});

describe("document.modelContext.getTools (polyfill)", () => {
  it("returns registered tools sorted by name with object inputSchema and defaults", async () => {
    installPolyfill();
    await mc().registerTool(makeTool({ name: "b_tool" }));
    await mc().registerTool(makeTool({ name: "a_tool" }));
    const tools = await mc().getTools!();
    expect(tools.map((t) => t.name)).toEqual(["a_tool", "b_tool"]);
    expect(typeof tools[0].inputSchema).toBe("object");
    expect(tools[0].title).toBe("");
    expect(tools[0].description).toBe("consumer test tool");
    expect(tools[0].origin).toBe(location.origin);
    expect(tools[0].window).toBe(window);
  });

  it("returns a deep copy of inputSchema (mutation does not leak back)", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [first] = await mc().getTools!();
    (first.inputSchema as Record<string, unknown>).type = "mutated";
    const [second] = await mc().getTools!();
    expect((second.inputSchema as Record<string, unknown>).type).toBe("object");
  });

  it("returns fresh objects on every call", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [a] = await mc().getTools!();
    const [b] = await mc().getTools!();
    expect(a).not.toBe(b);
  });

  it("preserves title and annotations when registered", async () => {
    installPolyfill();
    await mc().registerTool(
      makeTool({ title: "Nice Tool", annotations: { readOnlyHint: true } }),
    );
    const [tool] = await mc().getTools!();
    expect(tool.title).toBe("Nice Tool");
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it("rejects SecurityError for an untrustworthy fromOrigins entry", async () => {
    installPolyfill();
    await expect(mc().getTools!({ fromOrigins: ["http://evil.example"] })).rejects.toThrow(
      expect.objectContaining({ name: "SecurityError" }),
    );
  });
});

describe("document.modelContext.executeTool (polyfill)", () => {
  it("executes by RegisteredTool and resolves the JSON result", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [tool] = await mc().getTools!();
    const raw = await mc().executeTool!(tool, '{"query":"x"}');
    expect(JSON.parse(raw as string)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("accepts an object inputArguments", async () => {
    installPolyfill();
    await mc().registerTool(makeTool());
    const [tool] = await mc().getTools!();
    const raw = await mc().executeTool!(tool, { query: "x" });
    expect(JSON.parse(raw as string)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("rejects UnknownError for a stale/unregistered tool", async () => {
    installPolyfill();
    const stale: RegisteredTool = { name: "ghost", description: "gone" };
    await expect(mc().executeTool!(stale, "{}")).rejects.toThrow(
      expect.objectContaining({ name: "UnknownError" }),
    );
  });

  it("forwards the caller signal: tool-side signal aborts, caller gets its reason", async () => {
    installPolyfill();
    let toolAborted = false;
    await mc().registerTool(
      makeTool({
        inputSchema: undefined,
        execute: (_input, { signal }) =>
          new Promise<CallToolResult>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                toolAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
    );
    const [tool] = await mc().getTools!();
    const controller = new AbortController();
    const reason = new Error("cancel it");
    const promise = mc().executeTool!(tool, "{}", { signal: controller.signal });
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(toolAborted).toBe(true);
  });

  it("keeps an in-flight execution alive when the tool is unregistered mid-flight", async () => {
    installPolyfill();
    const registration = new AbortController();
    let resolveTool!: (r: CallToolResult) => void;
    let toolSignalAborted = false;
    await mc().registerTool(
      makeTool({
        inputSchema: undefined,
        execute: (_input, { signal }) => {
          signal.addEventListener("abort", () => {
            toolSignalAborted = true;
          });
          return new Promise<CallToolResult>((resolve) => {
            resolveTool = resolve;
          });
        },
      }),
      { signal: registration.signal },
    );
    const [tool] = await mc().getTools!();
    const pending = mc().executeTool!(tool, "{}");
    await Promise.resolve(); // let execute start
    registration.abort(); // unregister mid-flight (Chrome 153.0.8008+ behavior)
    resolveTool({ content: [{ type: "text", text: "late-ok" }] });
    const raw = await pending;
    expect(JSON.parse(raw as string).content[0].text).toBe("late-ok");
    expect(toolSignalAborted).toBe(false);
    expect((await mc().getTools!()).map((t) => t.name)).not.toContain("consumer_tool");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/polyfill/__tests__/consumer-api.test.ts`
Expected: FAIL — `getTools` is not a function on the polyfill.

- [ ] **Step 3: Add `get` to the registry**

In `src/polyfill/registry.ts`, add to the `RegistryInternal` interface:

```ts
  get(name: string): ToolDescriptor | undefined;
```

and to the returned object (next to `getTools`):

```ts
    get(name: string): ToolDescriptor | undefined {
      return tools.get(name);
    },
```

- [ ] **Step 4: Add the consumer API to `PolyfillModelContext` in `src/polyfill/index.ts`**

Update imports:

```ts
import type {
  ExecuteToolOptions,
  InputSchema,
  ModelContext,
  ModelContextGetToolOptions,
  RegisteredTool,
} from "../types";
import { runTool } from "./execute";
import { createRegistry, type RegistryInternal } from "./registry";
import { createTestingShim } from "./testing-shim";
import { isPotentiallyTrustworthyOrigin } from "./validation";
```

In the class: add a `#registry` field, set it in the constructor, and add the two methods:

```ts
class PolyfillModelContext extends EventTarget {
  readonly __isWebMCPPolyfill = true as const;
  registerTool: ModelContext["registerTool"];
  #registry: RegistryInternal;
  #ontoolchange: ((ev: Event) => unknown) | null = null;

  constructor(registry: RegistryInternal) {
    super();
    this.#registry = registry;
    this.registerTool = registry.registerTool;
  }

  getTools(options?: ModelContextGetToolOptions): Promise<RegisteredTool[]> {
    if (options?.fromOrigins) {
      for (const origin of options.fromOrigins) {
        if (!isPotentiallyTrustworthyOrigin(origin)) {
          return Promise.reject(
            new DOMException(
              "Only secure origins are allowed in the fromOrigins list.",
              "SecurityError",
            ),
          );
        }
      }
    }
    // Single-document polyfill: every registered tool is same-origin, so
    // fromOrigins never filters anything here.
    const tools = Array.from(this.#registry.getTools().values())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(
        (tool): RegisteredTool => ({
          name: tool.name,
          title: tool.title ?? "",
          description: tool.description,
          ...(tool.inputSchema && {
            // JSON round-trip: a deep copy, matching how Chrome 154 materializes
            // the object from the schema captured at registration.
            inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as InputSchema,
          }),
          ...(tool.annotations && { annotations: { ...tool.annotations } }),
          window,
          origin: location.origin,
        }),
      );
    return Promise.resolve(tools);
  }

  executeTool(
    tool: RegisteredTool,
    inputArguments: string | object,
    options?: ExecuteToolOptions,
  ): Promise<string | null> {
    const registered = tool ? this.#registry.get(tool.name) : undefined;
    if (!registered) {
      return Promise.reject(new DOMException(`Tool "${tool?.name}" not found`, "UnknownError"));
    }
    return runTool(registered, inputArguments, options?.signal);
  }

  // ontoolchange getter/setter unchanged
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- src/polyfill/__tests__/consumer-api.test.ts && pnpm typecheck`
Expected: PASS. Note: the unregister-mid-flight test passes without special code — the engine captured the descriptor before the registry deleted it.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/polyfill/registry.ts src/polyfill/index.ts src/polyfill/__tests__/consumer-api.test.ts
git commit -m "feat: add getTools()/executeTool() consumer API to the polyfill"
```

---

### Task 5: Testing shim → deprecated wrapper over the engine

**Files:**
- Modify: `src/polyfill/testing-shim.ts`
- Modify: `src/polyfill/__tests__/testing-shim.test.ts` (two assertion updates + one new test)

**Interfaces:**
- Consumes: `runTool` (Task 3), `RegistryInternal.get` (Task 4), `warnOnce` from `../utils/warn`.
- Produces: unchanged `ModelContextTesting` surface; shim `executeTool` now forwards the caller signal into the tool's `options.signal`.

- [ ] **Step 1: Update the two behavior-shape tests and add the deprecation test**

In `src/polyfill/__tests__/testing-shim.test.ts`:

(a) Replace the test `"calls execute with a single input argument (no client)"` with:

```ts
    it("calls execute with input and an options object carrying an AbortSignal", async () => {
      // Chrome 153+ shape: execute(input, { signal }).
      const registry = createRegistry();
      const shim = createTestingShim(registry);
      let args: unknown[] = [];
      await registry.registerTool({
        name: "arity_tool",
        description: "checks arity",
        execute: (...a: unknown[]) => {
          args = a;
          return { content: [{ type: "text", text: "ok" }] };
        },
      });
      await shim.executeTool("arity_tool", "{}");
      expect(args).toHaveLength(2);
      expect((args[1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });
```

(b) Replace the test `"does not produce unhandled rejection when handler aborts then throws"` with:

```ts
    it("rejects with the abort reason (not the handler error) when handler aborts then throws", async () => {
      // Chrome 152+: once aborted, the caller sees the abort reason; the
      // tool's late failure is discarded. No unhandled rejection either way.
      const controller = new AbortController();
      const { shim } = setup([
        makeTool({
          execute: () => {
            controller.abort();
            throw new Error("handler threw after aborting");
          },
        }),
      ]);

      await expect(
        shim.executeTool("test_tool", '{"query":"x"}', { signal: controller.signal }),
      ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    });
```

(c) Add a new test inside the `executeTool` describe:

```ts
    it("warns once about deprecation", async () => {
      _resetWarnings();
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { shim } = setup();
      await shim.executeTool("test_tool", '{"query":"x"}');
      shim.listTools();
      const deprecationWarns = spy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("modelContextTesting is deprecated"),
      );
      expect(deprecationWarns).toHaveLength(1);
      spy.mockRestore();
    });
```

Add to the imports at the top of the file: `import { _resetWarnings } from "../../utils/warn";`

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `pnpm test -- src/polyfill/__tests__/testing-shim.test.ts`
Expected: the three touched tests FAIL (arity is still 1, abort-then-throw still rejects with the handler error, no deprecation warning). All other shim tests PASS.

- [ ] **Step 3: Rewrite `src/polyfill/testing-shim.ts`**

```ts
import type { ModelContextTesting, ModelContextTestingExecuteToolOptions } from "../types";
import { warnOnce } from "../utils/warn";
import { runTool } from "./execute";
import type { RegistryInternal } from "./registry";

const DEPRECATION_KEY = "modelContextTesting-deprecated";
const DEPRECATION_MSG =
  "navigator.modelContextTesting is deprecated and will be removed in webmcp-react 0.4.0. " +
  "Use document.modelContext.getTools() / executeTool() instead.";

/** @deprecated Kept for one release as a wrapper over the modelContext consumer API. */
export function createTestingShim(registry: RegistryInternal): ModelContextTesting {
  let offChange: (() => void) | null = null;
  return {
    listTools() {
      warnOnce(DEPRECATION_KEY, DEPRECATION_MSG);
      return Array.from(registry.getTools().values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ? JSON.stringify(tool.inputSchema) : undefined,
      }));
    },

    async executeTool(
      toolName: string,
      inputArgsJson: string,
      options?: ModelContextTestingExecuteToolOptions,
    ): Promise<string | null> {
      warnOnce(DEPRECATION_KEY, DEPRECATION_MSG);
      const tool = registry.get(toolName);
      if (!tool) {
        throw new DOMException(`Tool "${toolName}" not found`, "NotFoundError");
      }

      // This legacy surface keeps its stricter, historical input errors
      // (OperationError; arrays rejected) — the engine itself is looser.
      let parsed: unknown;
      try {
        parsed = JSON.parse(inputArgsJson);
      } catch {
        throw new DOMException("Invalid JSON input", "OperationError");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new DOMException("Input must be a JSON object", "OperationError");
      }

      return runTool(tool, parsed as Record<string, unknown>, options?.signal);
    },

    registerToolsChangedCallback(callback: () => void) {
      offChange?.();
      offChange = registry.addChangeListener(callback);
    },

    getCrossDocumentScriptToolResult() {
      return Promise.resolve("[]");
    },
  };
}
```

- [ ] **Step 4: Run the shim tests**

Run: `pnpm test -- src/polyfill/__tests__/testing-shim.test.ts`
Expected: PASS. In particular these pass **unchanged**: "propagates handler errors" (the engine's `UnknownError` message contains the original), "rejects with AbortError when signal fires mid-execution", "rejects with AbortError when handler synchronously aborts", "rejects immediately with AbortError for pre-aborted signal" (the default abort reason is itself an `AbortError` DOMException).

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — smoke/integration/hook tests run through the shim path and now exercise the two-arg handler call end-to-end.

- [ ] **Step 6: Commit**

```bash
git add src/polyfill/testing-shim.ts src/polyfill/__tests__/testing-shim.test.ts
git commit -m "feat: delegate testing shim to the execution engine; deprecate it"
```

---

### Task 6: Docs, CHANGELOG, version 0.3.0, open PR 1

**Files:**
- Modify: `package.json` (version), `CHANGELOG.md`, `README.md`, `docs/api.md`, `AGENTS.md`, `skills/webmcp-add-tool/SKILL.md`, `skills/webmcp-setup/SKILL.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–5.
- Produces: the released 0.3.0 documentation surface; PR 1.

- [ ] **Step 1: Bump the version**

In `package.json`: `"version": "0.2.0"` → `"version": "0.3.0"`.

- [ ] **Step 2: CHANGELOG**

In `CHANGELOG.md`, retitle the current `## Unreleased` section to `## 0.3.0` and prepend the following to its body (keep the two existing bullets from Unreleased under "Changed"):

```markdown
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
  and warns once in dev. It will be removed in webmcp-react 0.4.0.
```

- [ ] **Step 3: README**

In `README.md`:
- Update the quick-start `handler` example (the `search_catalog` one near line 43) to show the signal:

```tsx
    handler: async ({ query }, { signal }) => ({
      content: [{ type: "text", text: await searchCatalog(query, { signal }) }],
    }),
```

- Replace the bullet `**Handlers take a single argument.** ...` in the 0.2.0 breaking-changes section is historical — leave it, but add a new section directly above `## Breaking changes in 0.2.0`:

```markdown
## What's new in 0.3.0

- **Handlers get an execution `AbortSignal`**: `handler(args, { signal })`. Chrome 153+
  aborts it when the agent cancels the call; on older Chrome the library substitutes a
  never-aborting signal, so `fetch(url, { signal })` is always safe. One-argument handlers
  keep working.
- **Consumer API in the polyfill**: `document.modelContext.getTools()` /
  `executeTool(tool, args, { signal }?)` — the same surface native Chrome 152+ ships.
- **`navigator.modelContextTesting` is deprecated** (removed from native Chrome in 152;
  removed from this library in 0.4.0).
```

- [ ] **Step 4: docs/api.md**

- Update the `handler` row in the Zod config table to:
  `(args, ctx) => CallToolResult \| Promise<CallToolResult>` — "Tool implementation. Receives the parsed input and `ctx: { signal: AbortSignal }`; the signal aborts when the agent cancels the execution (Chrome 153+; otherwise a never-aborting substitute)."
- Replace the sentence `The `handler` takes a **single argument** ...` with: "The `handler` receives the validated input object and a second `ctx` argument containing the execution `AbortSignal`. Handlers that declare a single parameter keep working."
- Update the `execute(input?)` row to `execute(input?, { signal }?)`.
- Add after the "Return value" section:

```markdown
### Cancellation

Each execution gets its own `AbortSignal`, passed to the handler as `ctx.signal`. On
Chrome 153.0.8007.0+ (and via the polyfill's `executeTool`) it aborts when the caller
cancels. When an aborted execution's handler rejects, the hook treats it as
**cancellation**: `isExecuting` clears, but `state.error` stays untouched and `onError`
does not fire. Unregistering a tool (unmount) does **not** cancel in-flight executions
(Chrome 153.0.8008.0+ behavior).
```

- In the "Polyfill behavior" section, replace the `navigator.modelContextTesting` bullet with the consumer API and add a compat table:

```markdown
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
```

- [ ] **Step 5: AGENTS.md**

- Replace the **Single-arg execute/handler** entry with:

```markdown
**Two-arg execute/handler**: `descriptor.execute(input, { signal })` and the user
`handler(args, ctx)` receive the execution `AbortSignal` as their second argument (Chrome
153+ shape). There is still no `ModelContextClient`. A missing second argument at runtime
(Chrome ≤152) is substituted with a never-aborting signal. Both execution paths must stay
mirrored — they share `runHandler` in `useMcpTool.ts` and `runTool` in
`polyfill/execute.ts`.
```

- In the Project Structure tree, add `│   ├── execute.ts      ← shared execution engine (signals, serialization, errors)` under `polyfill/` and change the `testing-shim.ts` line to `← DEPRECATED wrapper over execute.ts (removed in 0.4.0)`.
- In "Architecture Decisions", update the **AbortSignal-only unregistration** entry's last sentence: add "Unregistration does not cancel in-flight executions (Chrome 153.0.8008.0+); they run to completion."

- [ ] **Step 6: Skills**

In `skills/webmcp-add-tool/SKILL.md` and `skills/webmcp-setup/SKILL.md`, update one handler example each to the two-arg form with a comment, e.g.:

```tsx
    handler: async ({ query }, { signal }) => {
      // signal aborts if the agent cancels — forward it to cancellable work
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal });
      return { content: [{ type: "text", text: await res.text() }] };
    },
```

- [ ] **Step 7: Full check**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

- [ ] **Step 8: Commit and open PR 1**

```bash
git add -A
git commit -m "docs: 0.3.0 — execution signals, consumer API, modelContextTesting deprecation"
git push -u origin kashish/package-email-support-922aa3
gh pr create --base main --title "0.3.0: execution AbortSignals + document.modelContext consumer API" --body "$(cat <<'EOF'
Tracks Chrome 152–154 WebMCP changes (spec: docs/superpowers/specs/2026-08-21-webmcp-signal-and-consumer-api-design.md):

- Handlers now receive the execution AbortSignal: `handler(args, { signal })` (Chrome 153+ shape; never-aborting substitute on ≤152). Abort is treated as cancellation, not error.
- Polyfill gains `document.modelContext.getTools()` / `executeTool()` matching native Chrome (object `inputSchema` per Chrome 154, `UnknownError` failures, signal forwarding, in-flight executions survive unregistration).
- `navigator.modelContextTesting` is deprecated (removed from native Chrome in 152.0.7940.0); the shim now wraps the same engine. Removal planned for 0.4.0.
- Version 0.3.0.

Extension/examples migration follows in a stacked PR.
EOF
)"
```

---

## PR 2 — Extension + examples

> Start from PR 1's head: `git checkout -b kashish/webmcp-extension-modelcontext kashish/package-email-support-922aa3`

### Task 7: Extension `PageToolApi` adapter (migrate off `modelContextTesting`)

**Files:**
- Modify: `extension/src/types.ts`
- Modify: `extension/src/content-main.ts` (full rewrite)

**Interfaces:**
- Consumes: page-side `document.modelContext` (native or webmcp-react 0.3.0 polyfill), `navigator.modelContextTesting` (fallback).
- Produces: `PageToolApi { list(): Promise<BrowserTool[]>; execute(toolName, argsJson, signal): Promise<string | null>; onChange(cb): void }` (internal to content-main); `pendingExecutions: Map<string, AbortController>` (Task 8 adds the cancel path); page global types `PageModelContext`, `PageRegisteredTool`.

- [ ] **Step 1: Extend `extension/src/types.ts`**

Replace the `ModelContextTesting` declaration block at the top with:

```ts
/** @deprecated Removed from native Chrome in 152; kept as a fallback for pages on webmcp-react ≤0.2.0. */
interface ModelContextTesting {
  listTools(): BrowserTool[];
  executeTool(
    toolName: string,
    inputArgsJson: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
  registerToolsChangedCallback(callback: () => void): void;
}

export interface PageRegisteredTool {
  name: string;
  title?: string;
  description: string;
  /** JSON string on Chrome ≤153, object on Chrome 154+ / webmcp-react 0.3.0 polyfill. */
  inputSchema?: string | object;
  annotations?: Record<string, unknown>;
  window?: Window;
  origin?: string;
}

export interface PageModelContext extends EventTarget {
  getTools?(options?: { fromOrigins?: string[] }): Promise<PageRegisteredTool[]>;
  executeTool?(
    tool: PageRegisteredTool,
    inputArguments: string | object,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
}

declare global {
  interface Navigator {
    modelContextTesting?: ModelContextTesting;
  }
  interface Document {
    modelContext?: PageModelContext;
  }
}
```

- [ ] **Step 2: Rewrite `extension/src/content-main.ts`**

Full new content:

```ts
import type { BrowserTool, PageMessage, PageModelContext, PageRegisteredTool } from "./types";

const DEBUG = false;

console.log("[WebMCP Bridge] content-main loaded");

function postToIsolated(message: PageMessage) {
  window.postMessage(message, window.location.origin);
}

function sendToolsUpdate(tools: BrowserTool[]) {
  postToIsolated({ type: "WEBMCP_TOOLS_UPDATED", tools });
}

function schemaToString(schema: string | object | undefined): string | undefined {
  if (schema === undefined || schema === null) return undefined;
  return typeof schema === "string" ? schema : JSON.stringify(schema);
}

interface PageToolApi {
  list(): Promise<BrowserTool[]>;
  execute(toolName: string, argsJson: string, signal: AbortSignal): Promise<string | null>;
  onChange(callback: () => void): void;
}

// Chrome 150+ native / webmcp-react 0.3.0+ polyfill: the standard consumer API.
function createModelContextApi(mc: PageModelContext): PageToolApi {
  const getTools = mc.getTools?.bind(mc);
  const executeTool = mc.executeTool?.bind(mc);
  if (!getTools || !executeTool) throw new Error("modelContext consumer API unavailable");
  return {
    async list() {
      const tools = await getTools();
      return tools.map((t: PageRegisteredTool) => ({
        name: t.name,
        description: t.description,
        inputSchema: schemaToString(t.inputSchema),
      }));
    },
    async execute(toolName, argsJson, signal) {
      const tools = await getTools();
      const tool = tools.find((t: PageRegisteredTool) => t.name === toolName);
      if (!tool) throw new Error(`Tool "${toolName}" not found`);
      try {
        return await executeTool(tool, argsJson, { signal });
      } catch (err) {
        // Future Chrome may require an object instead of a JSON string.
        if (err instanceof TypeError) {
          return await executeTool(tool, JSON.parse(argsJson) as object, { signal });
        }
        throw err;
      }
    },
    onChange(callback) {
      mc.addEventListener("toolchange", callback);
    },
  };
}

// Fallback for pages on webmcp-react ≤0.2.0 / Chrome ≤151.
function createTestingApi(ctx: NonNullable<typeof navigator.modelContextTesting>): PageToolApi {
  return {
    list: () => Promise.resolve(ctx.listTools()),
    execute: (toolName, argsJson, signal) => ctx.executeTool(toolName, argsJson, { signal }),
    onChange: (callback) => ctx.registerToolsChangedCallback(callback),
  };
}

function detectApi(): PageToolApi | null {
  const mc = document.modelContext;
  if (mc && typeof mc.getTools === "function" && typeof mc.executeTool === "function") {
    return createModelContextApi(mc);
  }
  const mct = navigator.modelContextTesting;
  if (mct) return createTestingApi(mct);
  return null;
}

let api: PageToolApi | null = null;
const pendingExecutions = new Map<string, AbortController>();

function handleMessage(event: MessageEvent<PageMessage>) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "WEBMCP_EXECUTE_TOOL": {
      if (!api) {
        postToIsolated({
          type: "WEBMCP_TOOL_RESULT",
          requestId: data.requestId,
          result: null,
          error: "WebMCP API not available",
        });
        break;
      }
      const controller = new AbortController();
      pendingExecutions.set(data.requestId, controller);
      api
        .execute(data.toolName, data.argsJson, controller.signal)
        .then((result: string | null) => {
          postToIsolated({ type: "WEBMCP_TOOL_RESULT", requestId: data.requestId, result });
        })
        .catch((err: unknown) => {
          postToIsolated({
            type: "WEBMCP_TOOL_RESULT",
            requestId: data.requestId,
            result: null,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          pendingExecutions.delete(data.requestId);
        });
      break;
    }
    case "WEBMCP_REQUEST_TOOLS": {
      if (api) {
        api.list().then(sendToolsUpdate).catch(() => {});
      }
      break;
    }
  }
}

window.addEventListener("message", handleMessage);

// Poll for a WebMCP API: native modelContext, the 0.3.0 polyfill, or the
// legacy testing shim (0.2.0 pages). The polyfill installs on provider mount,
// so the API may appear well after document load.
const POLL_INTERVAL = 100;
const POLL_TIMEOUT = 10_000;
let elapsed = 0;

const pollTimer = setInterval(() => {
  elapsed += POLL_INTERVAL;
  const found = detectApi();

  if (found) {
    clearInterval(pollTimer);
    api = found;
    if (DEBUG) console.log("[WebMCP Bridge] WebMCP API found");
    api.list().then(sendToolsUpdate).catch(() => {});
    api.onChange(() => {
      api?.list().then(sendToolsUpdate).catch(() => {});
    });
    return;
  }

  if (elapsed >= POLL_TIMEOUT) {
    clearInterval(pollTimer);
    if (DEBUG) console.log("[WebMCP Bridge] no WebMCP API found after 10s, giving up");
  }
}, POLL_INTERVAL);
```

- [ ] **Step 3: Typecheck and build the extension**

Run: `pnpm typecheck:extension && pnpm build:extension`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add extension/src/types.ts extension/src/content-main.ts
git commit -m "feat(extension): migrate to document.modelContext with modelContextTesting fallback"
```

---

### Task 8: End-to-end cancellation (`CANCEL_TOOL` through all hops)

**Files:**
- Modify: `extension/src/types.ts` (three new message types)
- Modify: `extension/src/mcp-server/index.ts`
- Modify: `extension/src/mcp-server/tool-registry.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/content-isolated.ts`
- Modify: `extension/src/content-main.ts` (add the cancel case)

**Interfaces:**
- Consumes: `pendingExecutions` map from Task 7; MCP SDK `extra.signal` (`RequestHandlerExtra` passed as the second argument to `setRequestHandler` callbacks).
- Produces: `WsCancelToolRequest { type: "CANCEL_TOOL"; requestId }` (server→extension), `RuntimeCancelToolMessage { type: "CANCEL_TOOL"; requestId }` (background→content), `PageCancelToolMessage { type: "WEBMCP_CANCEL_TOOL"; requestId }` (isolated→main); `ToolRegistry.callTool(name, args, signal?)`.

- [ ] **Step 1: Add the message types in `extension/src/types.ts`**

```ts
export interface PageCancelToolMessage {
  type: "WEBMCP_CANCEL_TOOL";
  requestId: string;
}

export interface RuntimeCancelToolMessage {
  type: "CANCEL_TOOL";
  requestId: string;
}

export interface WsCancelToolRequest {
  type: "CANCEL_TOOL";
  requestId: string;
}
```

Add `PageCancelToolMessage` to the `PageMessage` union, `RuntimeCancelToolMessage` to the `RuntimeMessage` union, and `WsCancelToolRequest` to the `WsMessageFromServer` union.

- [ ] **Step 2: MCP server — forward the SDK's cancellation signal**

In `extension/src/mcp-server/index.ts`, change the CallTool handler to:

```ts
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return registry.callTool(
    request.params.name,
    (request.params.arguments as Record<string, unknown>) ?? {},
    extra.signal,
  );
});
```

- [ ] **Step 3: `ToolRegistry` — abort support**

In `extension/src/mcp-server/tool-registry.ts`:

Add `cleanup?: () => void;` to the `PendingCall` interface. Add `WsCancelToolRequest` to the types import.

Change `callTool` to accept and honor a signal (full replacement of the method from the `requestId` declaration down):

```ts
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    // ... keep the existing NAMESPACED_RE / tool-exists / ws-connected guards ...

    if (signal?.aborted) {
      const err = new Error("Tool call aborted by client");
      err.name = "AbortError";
      throw err;
    }

    const requestId = crypto.randomUUID();
    const ws = this.ws;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pendingCalls.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingCalls.delete(requestId);
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({ type: "CANCEL_TOOL", requestId } satisfies WsCancelToolRequest),
          );
        }
        const err = new Error("Tool call aborted by client");
        err.name = "AbortError";
        reject(err);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.pendingCalls.delete(requestId);
        resolve({
          isError: true,
          content: [
            { type: "text", text: `Tool call "${name}" timed out after ${CALL_TIMEOUT}ms` },
          ],
        });
      }, CALL_TIMEOUT);

      this.pendingCalls.set(requestId, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });

      const message: WsCallToolRequest = {
        type: "CALL_TOOL",
        requestId,
        tabId,
        toolName,
        argsJson: JSON.stringify(args),
      };

      ws.send(JSON.stringify(message));
    });
  }
```

In `handleMessage`'s `TOOL_RESULT` case, call `pending.cleanup?.();` right after `clearTimeout(pending.timer);`. In `clearConnection`, call `pending.cleanup?.();` next to each `clearTimeout(pending.timer);`.

- [ ] **Step 4: Background — relay `CANCEL_TOOL` to the owning tab**

In `extension/src/background.ts`, in the WebSocket message switch (next to the existing `case "CALL_TOOL"`), add:

```ts
    case "CANCEL_TOOL": {
      const { requestId } = data;
      const tabId = pendingCalls.get(requestId);
      if (tabId === undefined) break;
      // Drop the pending entry so the late error TOOL_RESULT from the page is ignored.
      pendingCalls.delete(requestId);
      chrome.tabs.sendMessage(
        tabId,
        { type: "CANCEL_TOOL", requestId } satisfies RuntimeMessage,
        () => {
          // Touch lastError so a closed tab doesn't log an unchecked-error warning.
          void chrome.runtime.lastError;
        },
      );
      break;
    }
```

(The existing `TOOL_RESULT` handler already ignores unknown requestIds via `if (!pendingCalls.has(requestId)) break;` — verify this line exists at `extension/src/background.ts:397` and do not remove it.)

- [ ] **Step 5: content-isolated — forward to the page**

In `extension/src/content-isolated.ts`, add to the `chrome.runtime.onMessage` switch:

```ts
      case "CANCEL_TOOL":
        window.postMessage(
          {
            type: "WEBMCP_CANCEL_TOOL",
            requestId: message.requestId,
          } satisfies PageMessage,
          window.location.origin,
        );
        sendResponse({ ok: true });
        break;
```

- [ ] **Step 6: content-main — abort the pending execution**

In `extension/src/content-main.ts`, add to the `handleMessage` switch:

```ts
    case "WEBMCP_CANCEL_TOOL": {
      pendingExecutions.get(data.requestId)?.abort();
      pendingExecutions.delete(data.requestId);
      break;
    }
```

- [ ] **Step 7: Typecheck and build**

Run: `pnpm typecheck:extension && pnpm build:extension`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add extension/src
git commit -m "feat(extension): forward MCP client cancellation end-to-end via CANCEL_TOOL"
```

---

### Task 9: Native-harness probes

**Files:**
- Modify: `examples/native-harness/src/App.tsx` (the `runSelfTest` function)

**Interfaces:**
- Consumes: library 0.3.0 types (`document.modelContext.getTools?/executeTool?` are typed optional).
- Produces: self-test lines the PR description cites as verification.

- [ ] **Step 1: Replace the `navigator.modelContextTesting` section of `runSelfTest`**

Replace everything from `const t = navigator.modelContextTesting;` through the `add` probe with:

```tsx
  // Consumer API (document.modelContext) — native Chrome 150+ or polyfill 0.3.0+.
  if (!mc.getTools || !mc.executeTool) {
    log("FAIL: document.modelContext.getTools/executeTool missing (Chrome ≤149 or webmcp-react ≤0.2.0)");
    return;
  }
  const tools = await mc.getTools();
  const names = tools.map((x) => x.name);
  log(
    names.includes("echo") && names.includes("add")
      ? "PASS: getTools"
      : `FAIL: getTools ${names}`,
  );

  // Chrome ≤153 returns inputSchema as a JSON string; 154+/polyfill as an object.
  const echoTool = tools.find((x) => x.name === "echo");
  const echoSchema =
    typeof echoTool?.inputSchema === "string"
      ? JSON.parse(echoTool.inputSchema)
      : echoTool?.inputSchema;
  log(
    echoSchema && typeof echoSchema === "object" && "properties" in echoSchema
      ? `PASS: inputSchema normalized (${typeof echoTool?.inputSchema})`
      : `FAIL: inputSchema ${JSON.stringify(echoTool?.inputSchema)}`,
  );

  const echoRaw = echoTool ? await mc.executeTool(echoTool, JSON.stringify({ text: "hi" })) : null;
  const echo = echoRaw ? JSON.parse(echoRaw) : null;
  log(
    echo?.content?.[0]?.text?.includes("hi") ? "PASS: executeTool echo" : `FAIL: echo ${echoRaw}`,
  );

  const addTool = tools.find((x) => x.name === "add");
  const addRaw = addTool ? await mc.executeTool(addTool, JSON.stringify({ a: 2, b: 3 })) : null;
  const add = addRaw ? JSON.parse(addRaw) : null;
  log(add?.content?.[0]?.text?.includes("5") ? "PASS: executeTool add" : `FAIL: add ${addRaw}`);
```

- [ ] **Step 2: Add the three new probes**

Insert after the `add` probe, before the already-aborted-registration probe:

```tsx
  // Probe: handler receives options.signal (Chrome 153.0.8007+ / polyfill 0.3.0+).
  {
    const reg = new AbortController();
    let sawSignal: unknown = "not-called";
    await mc.registerTool(
      {
        name: "signal_probe",
        description: "Probe execute options.signal.",
        execute: (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          sawSignal = options?.signal;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
      { signal: reg.signal },
    );
    const probeTool = (await mc.getTools()).find((x) => x.name === "signal_probe");
    if (probeTool) {
      await mc.executeTool(probeTool, "{}");
      log(
        sawSignal instanceof AbortSignal
          ? "PASS: execute received options.signal"
          : "INFO: no options.signal (Chrome ≤152)",
      );
    }
    reg.abort();
  }

  // Probe: caller abort → tool signal aborts (generic AbortError), caller rejects.
  {
    const reg = new AbortController();
    let toolAborted: string | null = null;
    await mc.registerTool(
      {
        name: "abort_flight_probe",
        description: "Probe mid-flight cancellation.",
        execute: (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              toolAborted =
                options.signal?.reason instanceof DOMException
                  ? options.signal.reason.name
                  : String(options.signal?.reason);
              reject(options.signal?.reason);
            });
          }),
      },
      { signal: reg.signal },
    );
    const probeTool = (await mc.getTools()).find((x) => x.name === "abort_flight_probe");
    if (probeTool) {
      const controller = new AbortController();
      const pending = mc.executeTool(probeTool, "{}", { signal: controller.signal });
      controller.abort(new DOMException("probe cancel", "AbortError"));
      await pending.then(
        () => log("FAIL: aborted executeTool resolved"),
        (err: unknown) =>
          log(
            `PASS: aborted executeTool rejected (caller: ${(err as { name?: string })?.name}, tool: ${toolAborted ?? "no signal (Chrome ≤152)"})`,
          ),
      );
    }
    reg.abort();
  }

  // Probe: unregister mid-flight — execution survives (Chrome 153.0.8008+ / polyfill 0.3.0+).
  {
    const reg = new AbortController();
    await mc.registerTool(
      {
        name: "unregister_probe",
        description: "Probe unregister-during-execution.",
        execute: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ content: [{ type: "text", text: "survived" }] }), 200),
          ),
      },
      { signal: reg.signal },
    );
    const probeTool = (await mc.getTools()).find((x) => x.name === "unregister_probe");
    if (probeTool) {
      const pending = mc.executeTool(probeTool, "{}");
      reg.abort(); // unregister while in flight
      await pending.then(
        (raw) =>
          log(
            String(raw).includes("survived")
              ? "PASS: unregister does not cancel in-flight execution"
              : `FAIL: unexpected result ${raw}`,
          ),
        (err: unknown) =>
          log(
            `INFO: in-flight execution rejected on unregister (${(err as { name?: string })?.name}; pre-153.0.8008 behavior)`,
          ),
      );
    }
  }
```

- [ ] **Step 3: Build the harness**

Run: `pnpm --filter webmcp-react-native-harness build`
Expected: PASS (tsc + vite).

- [ ] **Step 4: Commit**

```bash
git add examples/native-harness/src/App.tsx
git commit -m "feat(examples): native-harness probes for consumer API, signals, and unregister semantics"
```

---

### Task 10: Playground — DevPanel migration + cancellable `slow_hint` tool

**Files:**
- Modify: `examples/playground/src/components/DevPanel.tsx`
- Create: `examples/playground/src/tools/SlowHintTool.tsx`
- Modify: the playground component that mounts the tool components (find it with `grep -rn "GameStatusTool" examples/playground/src` — add the new tool beside the existing ones)

**Interfaces:**
- Consumes: `document.modelContext.getTools/executeTool` (library-typed), `useMcpTool` two-arg handler.
- Produces: a Cancel button in DevPanel; a `slow_hint` tool demonstrating signal-aware handlers.

- [ ] **Step 1: Create `examples/playground/src/tools/SlowHintTool.tsx`**

```tsx
import { useMcpTool } from "webmcp-react";
import { z } from "zod";

/** Demonstrates cancellable execution: resolves after 3s unless the execution signal aborts. */
export function SlowHintTool() {
  useMcpTool({
    name: "slow_hint",
    description:
      "Return a hint after a 3 second delay. Honors cancellation via the execution AbortSignal.",
    input: z.object({}),
    handler: (_args, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ content: [{ type: "text", text: "Patience is itself a hint." }] });
        }, 3000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Aborted", "AbortError"),
            );
          },
          { once: true },
        );
      }),
  });
  return null;
}
```

Mount it: in the file found via `grep -rn "GameStatusTool" examples/playground/src` (the JSX that renders `<GameStatusTool />` etc.), add `import { SlowHintTool } from "./tools/SlowHintTool";` (adjust the relative path to match the neighboring tool imports) and render `<SlowHintTool />` beside the other tool components.

- [ ] **Step 2: Migrate DevPanel to the consumer API and add Cancel**

In `examples/playground/src/components/DevPanel.tsx`:

(a) Add state: `const [abortController, setAbortController] = useState<AbortController | null>(null);`

(b) Replace `refreshTools` with an async version that prefers `document.modelContext` (note it must remain safe to call every 2s):

```tsx
  const refreshTools = useCallback(async () => {
    const mc = document.modelContext;
    let listed: ToolInfo[] = [];
    if (mc?.getTools) {
      const tools = await mc.getTools();
      listed = tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Chrome ≤153: string; Chrome 154+/polyfill 0.3.0: object.
        inputSchema:
          typeof t.inputSchema === "string"
            ? t.inputSchema
            : JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
      }));
    } else {
      const mct = (navigator as any).modelContextTesting;
      if (!mct) return;
      listed = mct.listTools();
    }
    setTools(listed);
    setSelectedTool((prev) => {
      if (prev && listed.some((t) => t.name === prev)) return prev;
      return listed.length > 0 ? listed[0].name : null;
    });
  }, []);
```

(Remove the now-unused `outputSchema` from `ToolInfo` and its two render usages — the shim never returned it either.)

(c) Replace the body of `handleExecute`'s `try` block's execution call:

```tsx
    const controller = new AbortController();
    setAbortController(controller);
    setIsExecuting(true);
    const start = performance.now();

    try {
      JSON.parse(inputValue); // validate
      const mc = document.modelContext;
      let raw: string | null;
      if (mc?.getTools && mc.executeTool) {
        const listed = await mc.getTools();
        const tool = listed.find((t) => t.name === selectedTool);
        if (!tool) throw new Error(`Tool "${selectedTool}" is no longer registered`);
        raw = await mc.executeTool(tool, inputValue, { signal: controller.signal });
      } else {
        raw = await (navigator as any).modelContextTesting.executeTool(selectedTool, inputValue, {
          signal: controller.signal,
        });
      }
      // ... keep the existing success setResults block unchanged, using `raw` ...
```

and in the `finally` block add `setAbortController(null);` before `setIsExecuting(false);`.

(d) Replace the Execute button with an Execute/Cancel pair:

```tsx
          <div className="devpanel-run-row">
            <button className="devpanel-run" onClick={handleExecute} disabled={isExecuting}>
              {isExecuting ? "Executing..." : "Execute"}
            </button>
            {isExecuting && (
              <button
                className="devpanel-cancel"
                onClick={() => abortController?.abort(new DOMException("Cancelled from DevPanel", "AbortError"))}
              >
                Cancel
              </button>
            )}
          </div>
```

- [ ] **Step 3: Build the playground**

Run: `pnpm --filter webmcp-react-playground build`
Expected: PASS.

- [ ] **Step 4: Manual verification (documented in the PR)**

Run: `pnpm dev:playground`, open the app, open DevPanel, select `slow_hint`, Execute, then Cancel within 3s.
Expected: the result row shows an error entry naming the abort (cancellation), and the game tools still execute normally. Record this in the PR description.

- [ ] **Step 5: Commit**

```bash
git add examples/playground/src
git commit -m "feat(examples): DevPanel on consumer API with cancellation; add slow_hint tool"
```

---

### Task 11: Extension docs, CHANGELOG, open PR 2

**Files:**
- Modify: `extension/README.md`, `extension/PRIVACY.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces: PR 2.

- [ ] **Step 1: Update extension docs**

In `extension/README.md` and `extension/PRIVACY.md`: replace each mention of `navigator.modelContextTesting` with `document.modelContext` (the consumer API: `getTools()` / `executeTool()`), and where the README describes how the bridge reads tools, note the fallback: "Pages using webmcp-react ≤0.2.0 are still supported via the deprecated `navigator.modelContextTesting` shim." Add one sentence to the README's feature list: "MCP client cancellations are forwarded to the page and abort the tool's execution `AbortSignal`."

- [ ] **Step 2: CHANGELOG**

Add at the top of `CHANGELOG.md` (above `## 0.3.0`):

```markdown
## Unreleased

### Extension

- The bridge extension now discovers and executes tools via
  `document.modelContext.getTools()` / `executeTool()` (native Chrome 150+ and the
  webmcp-react 0.3.0 polyfill), falling back to the deprecated
  `navigator.modelContextTesting` for pages on webmcp-react ≤0.2.0. Native Chrome removed
  `modelContextTesting` in 152.0.7940.0, which had left the extension unable to see tools
  on native Chrome.
- MCP client cancellations (`notifications/cancelled`) are forwarded end-to-end: MCP SDK →
  WebSocket `CANCEL_TOOL` → background → content scripts → `executeTool`'s `AbortSignal`,
  aborting the tool handler's execution signal.
```

- [ ] **Step 3: Full check**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm typecheck:extension && pnpm build:extension && pnpm --filter webmcp-react-playground build && pnpm --filter webmcp-react-native-harness build`
Expected: all PASS.

- [ ] **Step 4: Commit and open PR 2 (stacked on PR 1)**

```bash
git add -A
git commit -m "docs(extension): document modelContext migration and cancellation"
git push -u origin kashish/webmcp-extension-modelcontext
gh pr create --base kashish/package-email-support-922aa3 --title "Extension + examples: migrate to document.modelContext, end-to-end cancellation" --body "$(cat <<'EOF'
Stacked on the 0.3.0 library PR (retarget to main after it merges).

- Bridge extension discovers/executes tools via document.modelContext.getTools()/executeTool() with a modelContextTesting fallback for webmcp-react ≤0.2.0 pages (native Chrome removed modelContextTesting in 152.0.7940.0).
- MCP client cancellation forwarded end-to-end (SDK extra.signal → WS CANCEL_TOOL → background → content scripts → executeTool AbortSignal).
- native-harness: probes for getTools/executeTool, string-vs-object inputSchema, execution signals, mid-flight abort, unregister-survives-execution.
- playground: DevPanel on the consumer API with a Cancel button; new slow_hint tool demonstrates signal-aware handlers.

Verification: `pnpm typecheck:extension && pnpm build:extension`, example builds, harness probes against the polyfill and Chrome canary, manual DevPanel cancel of slow_hint (see spec §5).
EOF
)"
```

---

## Plan Self-Review Notes

- Spec §1 → Task 1; §2 → Task 2; §3 → Tasks 3–5; §4 → Tasks 7–10; §5 tests → Tasks 2–5 test steps, docs/versioning → Tasks 6 and 11; risks (object-only `executeTool` input) → Task 7's `TypeError` retry and Task 3's object-input support.
- The shim keeps its historical `OperationError`/`NotFoundError` input errors by parsing before delegating (Task 5), so only two existing tests change shape — both updated with Chrome-version comments, none deleted.
- Names used across tasks are consistent: `ToolExecuteCallbackOptions`, `ExecuteToolOptions`, `RegisteredTool`, `runHandler`, `runTool`, `RegistryInternal.get`, `PageToolApi`, `pendingExecutions`, `PendingCall.cleanup`, `CANCEL_TOOL`/`WEBMCP_CANCEL_TOOL`.
