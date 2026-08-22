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
