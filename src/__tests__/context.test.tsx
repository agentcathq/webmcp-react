import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetPolyfillConsumerCount, useWebMCPStatus, WebMCPProvider } from "../context";
import { cleanupPolyfill } from "../polyfill";
import { _resetWarnings } from "../utils/warn";

// ─── Helpers ──────────────────────────────────────────────────────

function StatusDisplay() {
  const { available } = useWebMCPStatus();
  return <div data-testid="status">{available ? "yes" : "no"}</div>;
}

function deleteNativeModelContext() {
  const desc = Object.getOwnPropertyDescriptor(document, "modelContext");
  if (desc) {
    Object.defineProperty(document, "modelContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete document.modelContext;
  }
}

// ─── Setup / teardown ─────────────────────────────────────────────

afterEach(() => {
  cleanup();
  cleanupPolyfill();
  _resetPolyfillConsumerCount();
  _resetWarnings();
  vi.restoreAllMocks();
});

// ─── Availability detection ───────────────────────────────────────

describe("WebMCPProvider availability", () => {
  it("available becomes true after mount", async () => {
    const { getByTestId } = render(
      <WebMCPProvider name="test" version="1.0">
        <StatusDisplay />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(getByTestId("status")).toHaveTextContent("yes");
    });
  });

  it("available is true when native API exists", async () => {
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

    try {
      const { getByTestId } = render(
        <WebMCPProvider name="test" version="1.0">
          <StatusDisplay />
        </WebMCPProvider>,
      );

      await waitFor(() => {
        expect(getByTestId("status")).toHaveTextContent("yes");
      });
      // Native API should still be the original, not replaced by polyfill
      expect(document.modelContext).toBe(native);
    } finally {
      deleteNativeModelContext();
    }
  });

  it("available is true with a signal-only native API (Chrome 148+)", async () => {
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

    try {
      const { getByTestId } = render(
        <WebMCPProvider name="test" version="1.0">
          <StatusDisplay />
        </WebMCPProvider>,
      );

      await waitFor(() => {
        expect(getByTestId("status")).toHaveTextContent("yes");
      });
      expect(document.modelContext).toBe(native);
    } finally {
      deleteNativeModelContext();
    }
  });
});

// ─── Polyfill lifecycle ───────────────────────────────────────────

describe("polyfill lifecycle", () => {
  it("installs polyfill when no native API present", async () => {
    render(
      <WebMCPProvider name="test" version="1.0">
        <div />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(document.modelContext).toBeDefined();
    });
    expect((document.modelContext as unknown as Record<string, unknown>).__isWebMCPPolyfill).toBe(
      true,
    );
  });

  it("does not install polyfill when native API present", async () => {
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

    try {
      render(
        <WebMCPProvider name="test" version="1.0">
          <div />
        </WebMCPProvider>,
      );

      await waitFor(() => {
        expect(document.modelContext).toBe(native);
      });
      expect(
        (document.modelContext as unknown as Record<string, unknown>).__isWebMCPPolyfill,
      ).toBeUndefined();
    } finally {
      deleteNativeModelContext();
    }
  });

  it("cleans up polyfill on unmount", async () => {
    const { unmount } = render(
      <WebMCPProvider name="test" version="1.0">
        <div />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(document.modelContext).toBeDefined();
    });

    unmount();
    expect(document.modelContext).toBeUndefined();
  });

  it("does not clean up native API on unmount", async () => {
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

    try {
      const { unmount } = render(
        <WebMCPProvider name="test" version="1.0">
          <div />
        </WebMCPProvider>,
      );

      await waitFor(() => {
        expect(document.modelContext).toBe(native);
      });

      unmount();
      expect(document.modelContext).toBe(native);
    } finally {
      deleteNativeModelContext();
    }
  });
});

// ─── Multi-provider lifecycle ─────────────────────────────────────

describe("multi-provider lifecycle", () => {
  it("polyfill persists when one of two providers unmounts", async () => {
    const result1 = render(
      <WebMCPProvider name="app1" version="1.0">
        <StatusDisplay />
      </WebMCPProvider>,
    );

    const result2 = render(
      <WebMCPProvider name="app2" version="1.0">
        <div data-testid="status2" />
      </WebMCPProvider>,
    );

    await waitFor(() => {
      expect(result1.getByTestId("status")).toHaveTextContent("yes");
    });

    // Unmount first provider — polyfill should still be alive
    result1.unmount();
    expect(document.modelContext).toBeDefined();
    expect((document.modelContext as unknown as Record<string, unknown>).__isWebMCPPolyfill).toBe(
      true,
    );

    // Unmount second provider — now polyfill should be cleaned up
    result2.unmount();
    expect(document.modelContext).toBeUndefined();
  });
});

// ─── SSR safety ───────────────────────────────────────────────────

describe("SSR safety", () => {
  it("renderToString produces available: false", () => {
    const html = renderToString(
      <WebMCPProvider name="test" version="1.0">
        <StatusDisplay />
      </WebMCPProvider>,
    );
    expect(html).toContain("no");
    expect(html).not.toContain("yes");
  });
});

// ─── Missing provider warning ─────────────────────────────────────

describe("useWebMCPStatus outside provider", () => {
  it("returns { available: false }", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    function Orphan() {
      const { available } = useWebMCPStatus();
      return <div data-testid="status">{available ? "yes" : "no"}</div>;
    }

    const { getByTestId } = render(<Orphan />);
    expect(getByTestId("status")).toHaveTextContent("no");
  });

  it("fires console.warn once", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    function Orphan() {
      useWebMCPStatus();
      return null;
    }

    render(<Orphan />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("useWebMCPStatus must be used inside <WebMCPProvider>"),
    );
  });

  it("does not repeat warning on re-render", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    function Orphan({ count }: { count: number }) {
      useWebMCPStatus();
      return <div>{count}</div>;
    }

    const { rerender } = render(<Orphan count={1} />);
    rerender(<Orphan count={2} />);
    rerender(<Orphan count={3} />);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─── Strict Mode ──────────────────────────────────────────────────

describe("Strict Mode", () => {
  it("available becomes true and unmount cleans up", async () => {
    const { getByTestId, unmount } = render(
      <StrictMode>
        <WebMCPProvider name="test" version="1.0">
          <StatusDisplay />
        </WebMCPProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(getByTestId("status")).toHaveTextContent("yes");
    });

    unmount();
    expect(document.modelContext).toBeUndefined();
  });
});
