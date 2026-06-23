import { afterEach, describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../../types";
import { cleanupPolyfill, installPolyfill } from "../index";

describe("installPolyfill / cleanupPolyfill", () => {
  afterEach(() => {
    cleanupPolyfill();
  });

  it("installPolyfill creates navigator.modelContext", () => {
    installPolyfill();
    expect(navigator.modelContext).toBeDefined();
  });

  it("installPolyfill creates navigator.modelContextTesting", () => {
    installPolyfill();
    expect(navigator.modelContextTesting).toBeDefined();
  });

  it("modelContext has __isWebMCPPolyfill marker", () => {
    installPolyfill();
    expect((navigator.modelContext as Record<string, unknown>).__isWebMCPPolyfill).toBe(true);
  });

  it("installPolyfill is idempotent", () => {
    installPolyfill();
    const first = navigator.modelContext;
    const firstTesting = navigator.modelContextTesting;
    installPolyfill();
    expect(navigator.modelContext).toBe(first);
    expect(navigator.modelContextTesting).toBe(firstTesting);
  });

  it("installPolyfill skips when native API exists", () => {
    const native = {
      registerTool() {
        return Promise.resolve(undefined);
      },
    };
    Object.defineProperty(navigator, "modelContext", {
      value: native,
      configurable: true,
      enumerable: true,
      writable: false,
    });

    installPolyfill();
    expect(navigator.modelContext).toBe(native);

    // Manual cleanup since our polyfill wasn't installed
    Object.defineProperty(navigator, "modelContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete navigator.modelContext;
  });

  it("navigator.modelContext is not writable", () => {
    installPolyfill();
    const desc = Object.getOwnPropertyDescriptor(navigator, "modelContext");
    expect(desc?.writable).toBe(false);
  });

  it("cleanupPolyfill removes polyfill properties", () => {
    installPolyfill();
    cleanupPolyfill();
    expect(navigator.modelContext).toBeUndefined();
    expect(navigator.modelContextTesting).toBeUndefined();
  });

  it("cleanupPolyfill restores previous property descriptors", () => {
    const original = {
      registerTool() {
        return Promise.resolve(undefined);
      },
    };
    Object.defineProperty(navigator, "modelContext", {
      value: original,
      configurable: true,
      enumerable: true,
      writable: false,
    });

    // Mark it as polyfill so installPolyfill doesn't skip it
    (original as Record<string, unknown>).__isWebMCPPolyfill = true;

    installPolyfill();
    expect(navigator.modelContext).not.toBe(original);

    cleanupPolyfill();
    expect(navigator.modelContext).toBe(original);

    // Final cleanup
    Object.defineProperty(navigator, "modelContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete navigator.modelContext;
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
    expect(navigator.modelContext).toBeUndefined();
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

    const mc = navigator.modelContext as NonNullable<typeof navigator.modelContext>;
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
    expect(navigator.modelContext).toBeUndefined();
    expect(navigator.modelContextTesting).toBeUndefined();
  });
});
