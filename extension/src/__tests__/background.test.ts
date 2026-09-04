import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service worker is restarted whenever Chrome decides it has been idle,
 * and that re-runs background.ts with an empty activation set. A content
 * script on an already-activated domain can report its tools during the
 * window where storage has not been read back yet.
 */

type Listener = (
  message: any,
  sender: any,
  sendResponse: (r?: any) => void,
) => boolean | void;

function installChrome(opts: {
  domains: string[];
  storageDelay: () => Promise<void>;
  grantedOrigins?: string[];
}) {
  const messageListeners: Listener[] = [];
  const updatedListeners: ((tabId: number, changeInfo: any) => void)[] = [];
  const registeredScripts: string[] = [];
  const stored: { domains: string[] } = { domains: opts.domains };
  const granted = opts.grantedOrigins ?? opts.domains;

  const chromeMock = {
    runtime: {
      onMessage: { addListener: (l: Listener) => messageListeners.push(l) },
      lastError: undefined,
    },
    storage: {
      local: {
        get: async () => {
          await opts.storageDelay();
          return { activatedDomains: stored.domains };
        },
        set: async (items: any) => {
          stored.domains = items.activatedDomains;
        },
      },
    },
    tabs: {
      get: async (id: number) => ({ id, url: "https://app.example/flow" }),
      onRemoved: { addListener: () => {} },
      onUpdated: {
        addListener: (l: (tabId: number, changeInfo: any) => void) =>
          updatedListeners.push(l),
      },
      sendMessage: async () => {},
    },
    scripting: {
      registerContentScripts: async (scripts: any[]) => {
        for (const sc of scripts) registeredScripts.push(sc.matches[0]);
      },
      unregisterContentScripts: async () => {},
      getRegisteredContentScripts: async () => [],
      executeScript: async () => [],
    },
    permissions: {
      remove: async () => true,
      contains: async ({ origins }: { origins: string[] }) =>
        granted.some((o) => origins[0] === `${o}/*`),
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
  };

  (globalThis as any).chrome = chromeMock;

  // Never let the module open a real socket.
  (globalThis as any).WebSocket = class {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    send() {}
    close() {}
  };

  return { messageListeners, updatedListeners, registeredScripts, stored };
}

function send(listeners: Listener[], message: any, sender: any = {}) {
  return new Promise<any>((resolve) => {
    for (const l of listeners) l(message, sender, resolve);
    // Fire-and-forget messages never respond.
    setTimeout(() => resolve(undefined), 0);
  });
}

async function statusToolNames(listeners: Listener[], tabId: number) {
  const status = await send(listeners, { type: "GET_STATUS", tabId }, {});
  const tab = status?.tabs?.find((t: any) => t.tabId === tabId);
  return tab ? tab.toolNames : [];
}

const TOOLS = [{ name: "reflow_run", description: "d", inputSchema: { type: "object" } }];
const SENDER = {
  tab: { id: 7, url: "https://app.example/flow", title: "Flow" },
};

describe("TOOLS_UPDATED before the persisted activations load", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps the tools of a domain that was activated in a previous session", async () => {
    let releaseStorage: () => void = () => {};
    const storageRead = new Promise<void>((r) => {
      releaseStorage = r;
    });

    const { messageListeners } = installChrome({
      domains: ["https://app.example"],
      storageDelay: () => storageRead,
    });

    await import("../background");

    // The page registers while chrome.storage.local.get is still in flight.
    await send(messageListeners, { type: "TOOLS_UPDATED", tools: TOOLS }, SENDER);

    releaseStorage();
    await new Promise((r) => setTimeout(r, 0));

    expect(await statusToolNames(messageListeners, 7)).toEqual(["reflow_run"]);
  });

  it("still drops the tools of a tab that is not activated", async () => {
    const { messageListeners } = installChrome({
      domains: [],
      storageDelay: async () => {},
    });

    await import("../background");
    await send(messageListeners, { type: "TOOLS_UPDATED", tools: TOOLS }, SENDER);
    await new Promise((r) => setTimeout(r, 0));

    expect(await statusToolNames(messageListeners, 7)).toEqual([]);
  });
});


describe("a persisted domain whose host permission is gone", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is dropped, so the popup does not report a domain nothing can reach", async () => {
    const { registeredScripts, stored } = installChrome({
      domains: ["https://app.example"],
      grantedOrigins: [],
      storageDelay: async () => {},
    });

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    expect(stored.domains).toEqual([]);
    expect(registeredScripts).toEqual([]);
  });

  it("is kept, and its content scripts registered, while the permission holds", async () => {
    const { registeredScripts, stored } = installChrome({
      domains: ["https://app.example"],
      storageDelay: async () => {},
    });

    await import("../background");
    await new Promise((r) => setTimeout(r, 0));

    expect(stored.domains).toEqual(["https://app.example"]);
    expect(registeredScripts).toEqual([
      "https://app.example/*",
      "https://app.example/*",
    ]);
  });
});


describe("an in-app route change", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadWithTools() {
    const ctx = installChrome({
      domains: ["https://app.example"],
      storageDelay: async () => {},
    });
    await import("../background");
    await send(ctx.messageListeners, { type: "TOOLS_UPDATED", tools: TOOLS }, SENDER);
    await new Promise((r) => setTimeout(r, 0));
    expect(await statusToolNames(ctx.messageListeners, 7)).toEqual(["reflow_run"]);
    return ctx;
  }

  it("keeps the tools when only the fragment changes", async () => {
    const ctx = await loadWithTools();

    for (const l of ctx.updatedListeners) {
      l(7, { status: "loading", url: "https://app.example/flow#/regions?search=" });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(await statusToolNames(ctx.messageListeners, 7)).toEqual(["reflow_run"]);
  });

  it("drops them when the document itself changes", async () => {
    const ctx = await loadWithTools();

    for (const l of ctx.updatedListeners) {
      l(7, { status: "loading", url: "https://app.example/other" });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(await statusToolNames(ctx.messageListeners, 7)).toEqual([]);
  });
});
