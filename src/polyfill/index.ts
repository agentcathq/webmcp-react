import type { ModelContext } from "../types";
import { createRegistry } from "./registry";
import { createTestingShim } from "./testing-shim";

interface PolyfillModelContext extends ModelContext {
  __isWebMCPPolyfill: true;
}

let installed = false;
let previousModelContext: PropertyDescriptor | undefined;
let previousModelContextTesting: PropertyDescriptor | undefined;

export function installPolyfill(): void {
  if (typeof window === "undefined") return;

  if (navigator.modelContext && !("__isWebMCPPolyfill" in navigator.modelContext)) {
    return;
  }

  if (installed) return;

  previousModelContext = Object.getOwnPropertyDescriptor(navigator, "modelContext");
  previousModelContextTesting = Object.getOwnPropertyDescriptor(navigator, "modelContextTesting");

  const registry = createRegistry();
  const testingShim = createTestingShim(registry);

  const modelContext: PolyfillModelContext = {
    registerTool: registry.registerTool,
    __isWebMCPPolyfill: true,
  };

  Object.defineProperty(navigator, "modelContext", {
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
    Object.defineProperty(navigator, "modelContext", previousModelContext);
  } else {
    delete navigator.modelContext;
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
