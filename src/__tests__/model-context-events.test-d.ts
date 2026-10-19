import { describe, expectTypeOf, it } from "vitest";
import type { ToolActivatedEvent, ToolCancelEvent } from "../index";

type ModelContext = NonNullable<Document["modelContext"]>;

describe("ModelContext event types", () => {
  it("types toolactivated listeners with ToolActivatedEvent", () => {
    const mc = {} as ModelContext;
    mc.addEventListener("toolactivated", (ev) => {
      expectTypeOf(ev).toEqualTypeOf<ToolActivatedEvent>();
    });
    mc.removeEventListener("toolactivated", (ev) => {
      expectTypeOf(ev).toEqualTypeOf<ToolActivatedEvent>();
    });
  });

  it("types toolcancel listeners with ToolCancelEvent", () => {
    const mc = {} as ModelContext;
    mc.addEventListener("toolcancel", (ev) => {
      expectTypeOf(ev).toEqualTypeOf<ToolCancelEvent>();
    });
    mc.removeEventListener("toolcancel", (ev) => {
      expectTypeOf(ev).toEqualTypeOf<ToolCancelEvent>();
    });
  });

  it("keeps toolchange listeners typed as a bare Event", () => {
    const mc = {} as ModelContext;
    mc.addEventListener("toolchange", (ev) => {
      expectTypeOf(ev).toEqualTypeOf<Event>();
    });
  });

  it("exposes ontoolactivated and ontoolcancel handler attributes", () => {
    const mc = {} as ModelContext;
    expectTypeOf(mc.ontoolactivated).toEqualTypeOf<
      ((this: ModelContext, ev: ToolActivatedEvent) => unknown) | null
    >();
    expectTypeOf(mc.ontoolcancel).toEqualTypeOf<
      ((this: ModelContext, ev: ToolCancelEvent) => unknown) | null
    >();
    mc.ontoolactivated = null;
    mc.ontoolcancel = null;
  });

  it("exposes toolName on both events", () => {
    expectTypeOf<ToolActivatedEvent>().toExtend<Event>();
    expectTypeOf<ToolCancelEvent>().toExtend<Event>();
    expectTypeOf<ToolActivatedEvent["toolName"]>().toEqualTypeOf<string>();
    expectTypeOf<ToolCancelEvent["toolName"]>().toEqualTypeOf<string>();
  });

  it("still accepts event names it does not know about", () => {
    const mc = {} as ModelContext;
    mc.addEventListener("someotherevent", (ev) => {
      expectTypeOf(ev).toEqualTypeOf<Event>();
    });
    mc.removeEventListener("someotherevent", null);
  });

  it("reaches the new members through the global document augmentation", () => {
    document.modelContext?.addEventListener("toolactivated", (ev) => {
      expectTypeOf(ev.toolName).toEqualTypeOf<string>();
    });
    expectTypeOf(document.modelContext?.ontoolcancel).toEqualTypeOf<
      ((this: ModelContext, ev: ToolCancelEvent) => unknown) | null | undefined
    >();
  });
});
