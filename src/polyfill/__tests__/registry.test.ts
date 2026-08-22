import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "../../types";
import { createRegistry } from "../registry";

function makeTool(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    name: "test_tool",
    description: "A test tool",
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

describe("createRegistry", () => {
  it("registers a tool visible in getTools()", async () => {
    const registry = createRegistry();
    await registry.registerTool(makeTool());
    expect(registry.getTools().has("test_tool")).toBe(true);
  });

  it("resolves and inserts synchronously on success", async () => {
    const registry = createRegistry();
    const p = registry.registerTool(makeTool());
    expect(registry.getTools().has("test_tool")).toBe(true);
    await expect(p).resolves.toBeUndefined();
  });

  it("defaults inputSchema when absent", async () => {
    const registry = createRegistry();
    await registry.registerTool(makeTool({ inputSchema: undefined }));
    const stored = registry.getTools().get("test_tool");
    expect(stored?.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("preserves provided inputSchema", async () => {
    const registry = createRegistry();
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"] as const,
    };
    await registry.registerTool(makeTool({ inputSchema: schema }));
    const stored = registry.getTools().get("test_tool");
    expect(stored?.inputSchema).toEqual(schema);
  });

  it("rejects with InvalidStateError on duplicate name", async () => {
    const registry = createRegistry();
    await registry.registerTool(makeTool());
    await expect(registry.registerTool(makeTool())).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("rejects on empty / too-long / illegal name", async () => {
    const registry = createRegistry();
    await expect(registry.registerTool(makeTool({ name: "" }))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await expect(registry.registerTool(makeTool({ name: "a".repeat(129) }))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await expect(registry.registerTool(makeTool({ name: "bad name" }))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("rejects on empty description and non-function execute", async () => {
    const registry = createRegistry();
    await expect(registry.registerTool(makeTool({ description: "" }))).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await expect(
      registry.registerTool(makeTool({ execute: "x" as unknown as ToolDescriptor["execute"] })),
    ).rejects.toMatchObject({ name: "InvalidStateError" });
  });

  it("rejects on non-serializable inputSchema with TypeError", async () => {
    const registry = createRegistry();
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;
    await expect(
      registry.registerTool(makeTool({ inputSchema: circular as never })),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects on a non-trustworthy exposedTo origin with SecurityError", async () => {
    const registry = createRegistry();
    await expect(
      registry.registerTool(makeTool(), { exposedTo: ["http://evil.example"] }),
    ).rejects.toMatchObject({ name: "SecurityError" });
  });

  it("rejects with the signal's abort reason when the signal is already aborted (matches native Chrome 152)", async () => {
    const registry = createRegistry();
    const reason = new DOMException("torn down", "AbortError");
    await expect(
      registry.registerTool(makeTool(), { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(registry.getTools().has("test_tool")).toBe(false);
  });

  it("fans out to multiple listeners and supports unsubscribe", async () => {
    const registry = createRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const offA = registry.addChangeListener(a);
    registry.addChangeListener(b);
    await registry.registerTool(makeTool());
    await Promise.resolve();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    await registry.registerTool(makeTool({ name: "second" }));
    await Promise.resolve();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("batches rapid registrations into one notification", async () => {
    const registry = createRegistry();
    const cb = vi.fn();
    registry.addChangeListener(cb);

    // Synchronous insert; the notification is deferred to a microtask.
    void registry.registerTool(makeTool({ name: "a" }));
    void registry.registerTool(makeTool({ name: "b" }));
    void registry.registerTool(makeTool({ name: "c" }));

    expect(cb).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires notification after microtask for single registration", async () => {
    const registry = createRegistry();
    const cb = vi.fn();
    registry.addChangeListener(cb);

    void registry.registerTool(makeTool());
    expect(cb).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stores a shallow copy isolated from the original object", async () => {
    const registry = createRegistry();
    const tool = makeTool();
    await registry.registerTool(tool);

    (tool as unknown as Record<string, unknown>).description = "mutated";
    const stored = registry.getTools().get("test_tool");
    expect(stored?.description).toBe("A test tool");
  });

  describe("AbortSignal support", () => {
    it("removes tool when abort signal fires", async () => {
      const registry = createRegistry();
      const cb = vi.fn();
      registry.addChangeListener(cb);

      const controller = new AbortController();
      await registry.registerTool(makeTool(), { signal: controller.signal });
      expect(registry.getTools().has("test_tool")).toBe(true);

      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(1);

      controller.abort();
      expect(registry.getTools().has("test_tool")).toBe(false);

      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it("fires notification via microtask when abort removes a tool", async () => {
      const registry = createRegistry();
      const cb = vi.fn();
      registry.addChangeListener(cb);

      const controller = new AbortController();
      await registry.registerTool(makeTool(), { signal: controller.signal });
      await Promise.resolve();

      controller.abort();
      // notification not yet fired (queued as microtask)
      expect(cb).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it("stale abort does not remove a same-name re-registration", async () => {
      const registry = createRegistry();
      const cb = vi.fn();
      registry.addChangeListener(cb);

      const controller1 = new AbortController();
      await registry.registerTool(makeTool(), { signal: controller1.signal });
      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(1);

      // Abort the first registration, then re-register with a new signal
      controller1.abort();
      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(2);
      expect(registry.getTools().has("test_tool")).toBe(false);

      const controller2 = new AbortController();
      await registry.registerTool(makeTool(), { signal: controller2.signal });
      await Promise.resolve();
      expect(cb).toHaveBeenCalledTimes(3);

      // Abort the OLD signal again — should NOT remove the new registration
      controller1.abort();
      await Promise.resolve();
      expect(registry.getTools().has("test_tool")).toBe(true);
      expect(cb).toHaveBeenCalledTimes(3);
    });
  });
});
