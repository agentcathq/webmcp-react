import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "../../types";
import { cleanupPolyfill, installPolyfill } from "../index";

describe("installPolyfill / cleanupPolyfill", () => {
  afterEach(() => {
    cleanupPolyfill();
  });

  it("installPolyfill creates document.modelContext", () => {
    installPolyfill();
    expect(document.modelContext).toBeDefined();
    expect((document.modelContext as unknown as Record<string, unknown>).__isWebMCPPolyfill).toBe(
      true,
    );
  });

  it("installPolyfill creates navigator.modelContextTesting", () => {
    installPolyfill();
    expect(navigator.modelContextTesting).toBeDefined();
  });

  it("modelContext has __isWebMCPPolyfill marker", () => {
    installPolyfill();
    expect((document.modelContext as unknown as Record<string, unknown>).__isWebMCPPolyfill).toBe(
      true,
    );
  });

  it("installPolyfill is idempotent", () => {
    installPolyfill();
    const first = document.modelContext;
    const firstTesting = navigator.modelContextTesting;
    installPolyfill();
    expect(document.modelContext).toBe(first);
    expect(navigator.modelContextTesting).toBe(firstTesting);
  });

  it("does not install when native document.modelContext exists", () => {
    const native = { registerTool: () => Promise.resolve(undefined) };
    Object.defineProperty(document, "modelContext", { value: native, configurable: true });
    installPolyfill();
    expect(document.modelContext).toBe(native);
    delete (document as { modelContext?: unknown }).modelContext;
  });

  it("installPolyfill skips when native API exists", () => {
    const native = {
      registerTool() {
        return Promise.resolve(undefined);
      },
    };
    Object.defineProperty(document, "modelContext", {
      value: native,
      configurable: true,
      enumerable: true,
      writable: false,
    });

    installPolyfill();
    expect(document.modelContext).toBe(native);

    // Manual cleanup since our polyfill wasn't installed
    Object.defineProperty(document, "modelContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete (document as { modelContext?: unknown }).modelContext;
  });

  it("document.modelContext is not writable", () => {
    installPolyfill();
    const desc = Object.getOwnPropertyDescriptor(document, "modelContext");
    expect(desc?.writable).toBe(false);
  });

  it("cleanupPolyfill removes polyfill properties", () => {
    installPolyfill();
    cleanupPolyfill();
    expect(document.modelContext).toBeUndefined();
    expect(navigator.modelContextTesting).toBeUndefined();
  });

  it("cleanupPolyfill restores previous property descriptors", () => {
    const original = {
      registerTool() {
        return Promise.resolve(undefined);
      },
    };
    Object.defineProperty(document, "modelContext", {
      value: original,
      configurable: true,
      enumerable: true,
      writable: false,
    });

    // Mark it as polyfill so installPolyfill doesn't skip it
    (original as Record<string, unknown>).__isWebMCPPolyfill = true;

    installPolyfill();
    expect(document.modelContext).not.toBe(original);

    cleanupPolyfill();
    expect(document.modelContext).toBe(original);

    // Final cleanup
    Object.defineProperty(document, "modelContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete (document as { modelContext?: unknown }).modelContext;
  });

  it("cleanupPolyfill restores previous modelContextTesting descriptor", () => {
    const originalTesting = {
      listTools: () => [],
      executeTool: async () => null,
      registerToolsChangedCallback() {},
      getCrossDocumentScriptToolResult: async () => "[]",
    };
    Object.defineProperty(navigator, "modelContextTesting", {
      value: originalTesting,
      configurable: true,
      enumerable: true,
      writable: false,
    });

    installPolyfill();
    expect(navigator.modelContextTesting).not.toBe(originalTesting);

    cleanupPolyfill();
    expect(navigator.modelContextTesting).toBe(originalTesting);

    // Final cleanup
    Object.defineProperty(navigator, "modelContextTesting", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete navigator.modelContextTesting;
  });

  it("cleanupPolyfill is no-op when not installed", () => {
    expect(() => cleanupPolyfill()).not.toThrow();
    expect(document.modelContext).toBeUndefined();
  });

  it("dispatches toolchange when a tool is registered (addEventListener)", async () => {
    installPolyfill();
    const mc = document.modelContext as NonNullable<typeof document.modelContext>;
    const seen = vi.fn();
    mc.addEventListener("toolchange", seen);
    await mc.registerTool({
      name: "evt_tool",
      description: "d",
      execute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    await Promise.resolve();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toBeInstanceOf(Event);
  });

  it("invokes the ontoolchange handler", async () => {
    installPolyfill();
    const mc = document.modelContext as NonNullable<typeof document.modelContext>;
    const handler = vi.fn();
    mc.ontoolchange = handler;
    await mc.registerTool({
      name: "evt_tool2",
      description: "d",
      execute: () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("full lifecycle: install → register tool → execute via testing shim → cleanup", async () => {
    installPolyfill();

    const tool: ToolDescriptor = {
      name: "greet",
      description: "Says hello",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute: (args) => ({
        content: [{ type: "text", text: `Hello, ${(args as Record<string, string>).name}!` }],
      }),
    };

    const mc = document.modelContext as NonNullable<typeof document.modelContext>;
    mc.registerTool(tool);

    const testing = navigator.modelContextTesting as NonNullable<
      typeof navigator.modelContextTesting
    >;
    const tools = testing.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("greet");

    const result = await testing.executeTool("greet", JSON.stringify({ name: "World" }));
    expect(JSON.parse(result as string)).toEqual({
      content: [{ type: "text", text: "Hello, World!" }],
    });

    cleanupPolyfill();
    expect(document.modelContext).toBeUndefined();
    expect(navigator.modelContextTesting).toBeUndefined();
  });
});
