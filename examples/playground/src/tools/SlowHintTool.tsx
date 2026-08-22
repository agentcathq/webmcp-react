import { useMcpTool } from "webmcp-react";
import { z } from "zod";

/** Demonstrates cancellable execution: resolves after 3s unless the execution signal aborts. */
export function SlowHintTool() {
  useMcpTool({
    name: "slow_hint",
    description:
      "Return a hint after a 3 second delay. Honors cancellation via the execution AbortSignal.",
    input: z.object({}),
    handler: (_args, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ content: [{ type: "text", text: "Try a starter word with several vowels." }] });
        }, 3000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("Aborted", "AbortError"),
            );
          },
          { once: true },
        );
      }),
  });
  return null;
}
