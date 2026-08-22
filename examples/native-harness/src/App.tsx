import { useCallback, useEffect, useState } from "react";
import { WebMCPProvider, useMcpTool, useWebMCPStatus } from "webmcp-react";
import { z } from "zod";

/**
 * Registers the `echo` tool using a Zod input schema.
 * Marked read-only and exposed only to https://example.com to exercise the
 * `exposedTo` registration path.
 */
function EchoTool() {
  useMcpTool({
    name: "echo",
    title: "Echo",
    description: "Echo the provided text back to the caller.",
    input: z.object({ text: z.string() }),
    annotations: { readOnlyHint: true },
    exposedTo: ["https://example.com"],
    handler: (input) => ({
      content: [{ type: "text", text: input.text }],
    }),
  });
  return null;
}

/**
 * Registers the `add` tool using a raw JSON-Schema input definition.
 */
function AddTool() {
  useMcpTool({
    name: "add",
    title: "Add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
    handler: (args) => {
      const a = args.a as number;
      const b = args.b as number;
      return {
        content: [{ type: "text", text: String(a + b) }],
      };
    },
  });
  return null;
}

async function runSelfTest(log: (line: string) => void) {
  // Report which implementation backs document.modelContext.
  const mc = document.modelContext;
  if (!mc) {
    log("FAIL: document.modelContext missing");
    return;
  }
  const isPolyfill = "__isWebMCPPolyfill" in mc;
  log(isPolyfill ? "INFO: backend = polyfill" : "PASS: backend = native");

  // Consumer API (document.modelContext) — native Chrome or the 1.1.0+ polyfill.
  if (!mc.getTools || !mc.executeTool) {
    log("FAIL: document.modelContext.getTools/executeTool missing (Chrome <=149 or webmcp-react <=1.0.0)");
    return;
  }
  const tools = await mc.getTools();
  const names = tools.map((x) => x.name);
  log(
    names.includes("echo") && names.includes("add")
      ? "PASS: getTools"
      : `FAIL: getTools ${names}`,
  );

  // Chrome <=153 returns inputSchema as a JSON string; 154+/polyfill as an object.
  const echoTool = tools.find((x) => x.name === "echo");
  const echoSchema =
    typeof echoTool?.inputSchema === "string"
      ? JSON.parse(echoTool.inputSchema)
      : echoTool?.inputSchema;
  log(
    echoSchema && typeof echoSchema === "object" && "properties" in echoSchema
      ? `PASS: inputSchema normalized (${typeof echoTool?.inputSchema})`
      : `FAIL: inputSchema ${JSON.stringify(echoTool?.inputSchema)}`,
  );

  const echoRaw = echoTool ? await mc.executeTool(echoTool, JSON.stringify({ text: "hi" })) : null;
  const echo = echoRaw ? JSON.parse(echoRaw) : null;
  log(
    echo?.content?.[0]?.text?.includes("hi") ? "PASS: executeTool echo" : `FAIL: echo ${echoRaw}`,
  );

  const addTool = tools.find((x) => x.name === "add");
  const addRaw = addTool ? await mc.executeTool(addTool, JSON.stringify({ a: 2, b: 3 })) : null;
  const add = addRaw ? JSON.parse(addRaw) : null;
  log(add?.content?.[0]?.text?.includes("5") ? "PASS: executeTool add" : `FAIL: add ${addRaw}`);

  // Probe: handler receives options.signal (Chrome 153.0.8007+ / polyfill 1.1.0+).
  {
    const reg = new AbortController();
    let sawSignal: unknown = "not-called";
    await mc.registerTool(
      {
        name: "signal_probe",
        description: "Probe execute options.signal.",
        execute: (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          sawSignal = options?.signal;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
      { signal: reg.signal },
    );
    const probeTool = (await mc.getTools()).find((x) => x.name === "signal_probe");
    if (probeTool) {
      await mc.executeTool(probeTool, "{}");
      log(
        sawSignal instanceof AbortSignal
          ? "PASS: execute received options.signal"
          : "INFO: no options.signal (Chrome <=152)",
      );
    }
    reg.abort();
  }

  // Probe: caller abort → tool signal aborts (generic AbortError), caller rejects.
  {
    const reg = new AbortController();
    let toolAborted: string | null = null;
    await mc.registerTool(
      {
        name: "abort_flight_probe",
        description: "Probe mid-flight cancellation.",
        execute: (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              toolAborted =
                options.signal?.reason instanceof DOMException
                  ? options.signal.reason.name
                  : String(options.signal?.reason);
              reject(options.signal?.reason);
            });
          }),
      },
      { signal: reg.signal },
    );
    const probeTool = (await mc.getTools()).find((x) => x.name === "abort_flight_probe");
    if (probeTool) {
      const controller = new AbortController();
      const pending = mc.executeTool(probeTool, "{}", { signal: controller.signal });
      controller.abort(new DOMException("probe cancel", "AbortError"));
      await pending.then(
        () => log("FAIL: aborted executeTool resolved"),
        (err: unknown) =>
          log(
            `PASS: aborted executeTool rejected (caller: ${(err as { name?: string })?.name}, tool: ${toolAborted ?? "no signal (Chrome <=152)"})`,
          ),
      );
    }
    reg.abort();
  }

  // Probe: unregister mid-flight — execution survives (Chrome 153.0.8008+ / polyfill 1.1.0+).
  {
    const reg = new AbortController();
    await mc.registerTool(
      {
        name: "unregister_probe",
        description: "Probe unregister-during-execution.",
        execute: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ content: [{ type: "text", text: "survived" }] }), 200),
          ),
      },
      { signal: reg.signal },
    );
    const probeTool = (await mc.getTools()).find((x) => x.name === "unregister_probe");
    if (probeTool) {
      const pending = mc.executeTool(probeTool, "{}");
      reg.abort(); // unregister while in flight
      await pending.then(
        (raw) =>
          log(
            String(raw).includes("survived")
              ? "PASS: unregister does not cancel in-flight execution"
              : `FAIL: unexpected result ${raw}`,
          ),
        (err: unknown) =>
          log(
            `INFO: in-flight execution rejected on unregister (${(err as { name?: string })?.name}; pre-153.0.8008 behavior)`,
          ),
      );
    }
  }

  // Spec + native Chrome 152+: registerTool with an already-aborted signal
  // rejects with the signal's abort reason. Older native (<=151) resolved as a
  // no-op instead.
  try {
    const result = await mc.registerTool(
      {
        name: "abort_probe",
        description: "Probe already-aborted signal behavior.",
        execute: () => ({ content: [{ type: "text", text: "x" }] }),
      },
      { signal: AbortSignal.abort(new DOMException("probe", "AbortError")) },
    );
    log(`INFO: already-aborted register RESOLVED (value=${String(result)}; pre-152 native behavior)`);
  } catch (err) {
    const name = err instanceof Error ? err.name : String(err);
    log(`PASS: already-aborted register rejects (${name})`);
  }
}

/**
 * StatusPanel is rendered inside WebMCPProvider and uses useWebMCPStatus() to
 * reactively detect when the polyfill is installed, then attaches listeners.
 */
function StatusPanel() {
  const { available } = useWebMCPStatus();
  const [detection, setDetection] = useState<"native" | "polyfill" | "checking">(
    "checking",
  );
  const [toolchangeCount, setToolchangeCount] = useState(0);

  // Update detection once available
  useEffect(() => {
    if (available) {
      const mc = document.modelContext;
      setDetection(
        mc && "__isWebMCPPolyfill" in mc ? "polyfill" : "native",
      );
    }
  }, [available]);

  // Attach toolchange listener only when available
  useEffect(() => {
    if (!available) return;
    const mc = document.modelContext;
    if (!mc) return;
    const handler = () => setToolchangeCount((c) => c + 1);
    mc.addEventListener("toolchange", handler);
    return () => mc.removeEventListener("toolchange", handler);
  }, [available]);

  return (
    <>
      <section>
        <h2>Detection</h2>
        <p data-testid="detection">{detection}</p>
      </section>

      <section>
        <h2>Toolchange events</h2>
        <p data-testid="toolchange-count">{toolchangeCount}</p>
      </section>
    </>
  );
}

/**
 * SelfTestPanel wraps the self-test button and output.
 */
function SelfTestPanel() {
  const [selftestOutput, setSelftestOutput] = useState<string[]>([]);

  const handleRunSelfTest = useCallback(() => {
    setSelftestOutput([]);
    void runSelfTest((line) => setSelftestOutput((lines) => [...lines, line]));
  }, []);

  return (
    <section>
      <h2>Self-test</h2>
      <button data-testid="run-selftest" onClick={handleRunSelfTest}>
        Run self-test
      </button>
      <pre data-testid="selftest-output">
        {selftestOutput.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </pre>
    </section>
  );
}

function Harness() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>WebMCP Native Harness</h1>
      <StatusPanel />
      <SelfTestPanel />
    </main>
  );
}

export default function App() {
  return (
    <WebMCPProvider name="harness" version="0.2.0">
      <EchoTool />
      <AddTool />
      <Harness />
    </WebMCPProvider>
  );
}
