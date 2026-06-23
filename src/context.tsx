import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cleanupPolyfill, installPolyfill } from "./polyfill";
import type { WebMCPProviderProps, WebMCPStatus } from "./types";
import { warnOnce } from "./utils/warn";

interface WebMCPContextValue {
  available: boolean;
  name: string;
  version: string;
}

const MISSING_PROVIDER: WebMCPContextValue = {
  available: false,
  name: "",
  version: "",
};

const WebMCPContext = createContext<WebMCPContextValue>(MISSING_PROVIDER);

let polyfillConsumerCount = 0;

/** @internal */
function _resetPolyfillConsumerCount(): void {
  polyfillConsumerCount = 0;
}

function WebMCPProvider({ name, version, children }: WebMCPProviderProps) {
  const [available, setAvailable] = useState(false);
  const usesPolyfillRef = useRef(false);

  useEffect(() => {
    const hasNativeApi =
      !!document.modelContext && !("__isWebMCPPolyfill" in document.modelContext);

    if (!hasNativeApi) {
      installPolyfill();
      usesPolyfillRef.current = true;
      polyfillConsumerCount++;
    }

    setAvailable(!!document.modelContext);

    return () => {
      if (usesPolyfillRef.current) {
        polyfillConsumerCount--;
        usesPolyfillRef.current = false;
        if (polyfillConsumerCount === 0) {
          cleanupPolyfill();
        }
      }
    };
  }, []);

  const value = useMemo(() => ({ available, name, version }), [available, name, version]);

  return <WebMCPContext.Provider value={value}>{children}</WebMCPContext.Provider>;
}

function useWebMCPStatus(): WebMCPStatus {
  const ctx = useContext(WebMCPContext);
  if (ctx === MISSING_PROVIDER) {
    warnOnce(
      "missing-provider",
      "useWebMCPStatus must be used inside <WebMCPProvider>. Returning { available: false }.",
    );
  }
  return { available: ctx.available };
}

export {
  WebMCPProvider,
  useWebMCPStatus,
  WebMCPContext,
  MISSING_PROVIDER,
  _resetPolyfillConsumerCount,
};
