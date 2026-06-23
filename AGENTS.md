# AGENTS.md

This file is for AI agents contributing to the webmcp-react library.
For integrating webmcp-react into your app, see the [skills/](./skills) directory.

## Reference

- **WebMCP standard**: https://github.com/webmachinelearning/webmcp — the W3C spec this library implements
- **API reference**: [`docs/api.md`](./docs/api.md) — this library's full API docs

## Commands

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Build | `pnpm build` |
| Test | `pnpm test` |
| Test (watch) | `pnpm test:watch` |
| Test (single file) | `pnpm test -- path/to/file.test.tsx` |
| Type check | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Lint + fix | `pnpm lint:fix` |
| Full check before PR | `pnpm build && pnpm typecheck && pnpm lint && pnpm test` |

## Project Structure

```
src/                    ← core library (your focus)
├── index.ts            ← public API exports
├── types.ts            ← all TypeScript types
├── context.tsx         ← WebMCPProvider + useWebMCPStatus hook
├── hooks/
│   └── useMcpTool.ts   ← main hook for tool registration
├── polyfill/           ← document.modelContext polyfill
│   ├── index.ts        ← installPolyfill / cleanupPolyfill + polyfill marker
│   ├── registry.ts     ← in-memory tool storage
│   ├── testing-shim.ts ← simulates MCP client calls
│   └── validation.ts   ← input validation against JSON Schema
└── utils/
    ├── schema.ts       ← Zod → JSON Schema conversion + schema fingerprinting
    └── warn.ts         ← dev-only fire-once warnings
```

Other directories (don't modify unless explicitly asked):
- `extension/` — Chrome extension that bridges web tools to desktop MCP clients
- `examples/playground/` — Wordle demo showcasing dynamic tool registration
- `examples/nextjs/` — Next.js integration example
- `skills/` — agent skills for consumers of the library
- `docs/api.md` — full API reference

## Architecture Decisions — Don't "Fix" These

These patterns look like they could be simplified but exist for specific reasons:

**Ownership tokens** (`TOOL_OWNER_BY_NAME` in `useMcpTool.ts`): React StrictMode double-mounts components. The ownership token ensures only the surviving mount owns the tool registration and only the owner can unregister. Removing this causes duplicate or orphaned tools.

**Polyfill ref-counting** (`polyfillConsumerCount` in `context.tsx`): Multiple `<WebMCPProvider>` instances can coexist. The polyfill installs on first provider mount and cleans up when the last unmounts. Don't collapse this into a simple boolean.

**Schema fingerprinting** (`schemaFingerprint` in `utils/schema.ts`, used by `useMcpTool.ts`): useEffect deps use string fingerprints of schemas, not object references, to prevent infinite re-registration loops when schema objects are recreated each render. Don't switch to direct object comparison.

**Dual execution paths**: Tools execute via `execute()` (internal/UI calls) and via the testing shim (external MCP client calls). Both paths update the same reactive state and fire the same callbacks. Changes to one path must be mirrored in the other.

**Ref-wrapped config** (`configRef`, `handlerRef`, etc.): Refs wrap mutable config so the registration useEffect doesn't re-run on every render. These are not missed dependencies — they're intentional stability optimizations.

**`"use client"` banner**: Added at build time via `tsup.config.ts`, not in source files. This makes the library work with Next.js SSR. Don't add `"use client"` to source files.

**Native API detection**: The polyfill checks for native `document.modelContext` (document-only — it does not read `navigator.modelContext`) and skips installation if it exists. Don't remove this check — Chrome is shipping native WebMCP support.

**AbortSignal-only unregistration**: There is no `unregisterTool`. Tools are removed by aborting the `AbortSignal` passed to `registerTool`. `useMcpTool` aborts its controller on cleanup; the registry's abort listener removes the tool. Don't reintroduce an imperative unregister method.

**Single-arg execute/handler**: `descriptor.execute(input)` and the user `handler(args)` take a single argument. There is no `ModelContextClient` second argument. Both execution paths must stay mirrored.

## Testing

- **Framework**: Vitest + React Testing Library + jsdom
- **Location**: `__tests__/` directories adjacent to source files
- **StrictMode**: All tests must pass under React StrictMode (double-mount behavior)
- **Testing shim**: `polyfill/testing-shim.ts` simulates external MCP client calls — use it in tests to verify the full registration → execution → state update cycle
- **Coverage areas**: Registration lifecycle, execution state, error handling, input validation, SSR safety, StrictMode compatibility

When adding features, write tests that cover both execution paths (direct `execute()` and testing shim `executeTool()`).

## Code Style

Biome handles formatting and linting. Pre-commit hooks run `biome check --write` on staged files — this does both formatting and linting. Unfixable lint errors will block the commit.

Don't manually adjust formatting — just run `pnpm lint:fix` if needed.

## Conventions

- Tool names: `snake_case` (e.g., `search_catalog`)
- Tool components: PascalCase + `Tool` suffix (e.g., `SearchCatalogTool`)
- Handlers return `CallToolResult` with a `content` array — always (including error results with `isError: true`)
- Peer deps: React ≥ 18, React DOM ≥ 18, Zod ≥ 3. Only runtime dep is `zod-to-json-schema`
- Warnings use `warnOnce()` — dev-only, fires once per key to avoid console spam

## Boundaries

- Do NOT add new dependencies without discussion
- Do NOT change public API exports in `index.ts` without discussion
- Do NOT remove or weaken existing tests
- Do NOT add `"use client"` to source files (handled by build)
- Do NOT modify `extension/`, `examples/`, or `skills/` unless asked
