import type { ModelContext } from "../types";
import { createRegistry, type RegistryInternal } from "./registry";
import { createTestingShim } from "./testing-shim";

class PolyfillModelContext extends EventTarget {
  readonly __isWebMCPPolyfill = true as const;
  registerTool: ModelContext["registerTool"];
  #ontoolchange: ((ev: Event) => unknown) | null = null;

  constructor(registry: RegistryInternal) {
    super();
    this.registerTool = registry.registerTool;
  }

  get ontoolchange(): ((ev: Event) => unknown) | null {
    return this.#ontoolchange;
  }

  set ontoolchange(handler: ((ev: Event) => unknown) | null) {
    if (this.#ontoolchange) this.removeEventListener("toolchange", this.#ontoolchange);
    this.#ontoolchange = handler;
    if (handler) this.addEventListener("toolchange", handler);
  }
}

let installed = false;
let previousModelContext: PropertyDescriptor | undefined;
let previousModelContextTesting: PropertyDescriptor | undefined;

export function installPolyfill(): void {
  if (typeof window === "undefined") return;

  if (document.modelContext && !("__isWebMCPPolyfill" in document.modelContext)) {
    return;
  }

  if (installed) return;

  previousModelContext = Object.getOwnPropertyDescriptor(document, "modelContext");
  previousModelContextTesting = Object.getOwnPropertyDescriptor(navigator, "modelContextTesting");

  const registry = createRegistry();
  const testingShim = createTestingShim(registry);

  const modelContext = new PolyfillModelContext(registry);
  registry.addChangeListener(() => modelContext.dispatchEvent(new Event("toolchange")));

  Object.defineProperty(document, "modelContext", {
    value: modelContext,
    configurable: true,
    enumerable: true,
    writable: false,
  });

  Object.defineProperty(navigator, "modelContextTesting", {
    value: testingShim,
    configurable: true,
    enumerable: true,
    writable: false,
  });

  installed = true;
}

export function cleanupPolyfill(): void {
  if (!installed) return;

  if (previousModelContext) {
    Object.defineProperty(document, "modelContext", previousModelContext);
  } else {
    delete document.modelContext;
  }

  if (previousModelContextTesting) {
    Object.defineProperty(navigator, "modelContextTesting", previousModelContextTesting);
  } else {
    delete navigator.modelContextTesting;
  }

  installed = false;
  previousModelContext = undefined;
  previousModelContextTesting = undefined;
}
