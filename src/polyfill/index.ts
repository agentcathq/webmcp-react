import type {
  ExecuteToolOptions,
  InputSchema,
  ModelContext,
  ModelContextGetToolOptions,
  RegisteredTool,
  ToolDescriptor,
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
  /** The registration each object returned by getTools() describes. */
  #issued = new WeakMap<object, ToolDescriptor>();

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
      .map((tool) => {
        const issued: RegisteredTool = {
          name: tool.name,
          title: tool.title ?? "",
          description: tool.description,
          ...(tool.inputSchema && {
            // JSON round-trip: a deep copy, matching how Chrome 154 materializes
            // the object from the schema captured at registration.
            inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as InputSchema,
          }),
          ...(tool.outputSchema && {
            outputSchema: JSON.parse(JSON.stringify(tool.outputSchema)) as InputSchema,
          }),
          ...(tool.annotations && { annotations: { ...tool.annotations } }),
          source: window,
          window,
          origin: location.origin,
        };
        this.#issued.set(issued, tool);
        return issued;
      });
    return Promise.resolve(tools);
  }

  executeTool(
    tool: RegisteredTool,
    inputArguments?: string | object,
    options?: ExecuteToolOptions,
  ): Promise<string | null> {
    // An object from getTools() runs only the registration it was issued for, so a
    // tool unregistered and registered again under the same name doesn't match.
    // Other objects (1.x compatibility) are looked up by name.
    const issuedFor = tool ? this.#issued.get(tool) : undefined;
    const name = issuedFor?.name ?? tool?.name;
    const registered = name === undefined ? undefined : this.#registry.get(name);
    if (!registered || (issuedFor && issuedFor !== registered)) {
      return Promise.reject(new DOMException(`Tool "${tool?.name}" not found`, "UnknownError"));
    }
    const input = inputArguments === undefined && options === undefined ? {} : inputArguments;
    return runTool(registered, input, options?.signal);
  }

  /**
   * Accepted so pages can call it unconditionally. No agent reads the polyfill's
   * tools ready state, so the promise only gets a rejection handler, as it would
   * from the browser.
   */
  waitForToolsUntil(promise: Promise<unknown>): void {
    if (arguments.length === 0) {
      throw new TypeError(
        "Failed to execute 'waitForToolsUntil' on 'ModelContext': 1 argument required, but only 0 present.",
      );
    }
    Promise.resolve(promise).catch(() => undefined);
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
