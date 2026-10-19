import { useCallback, useEffect, useState } from "react";
import { useMcpTool, useWebMCPStatus, WebMCPProvider } from "webmcp-react";
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

/** Extracts a stable name from a caught value, DOMException-safe. */
function errName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : String(err);
}

async function waitForStart(started: Promise<void>, pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("Probe settled before its handler started");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Probe handler did not start")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    log(
      "FAIL: document.modelContext.getTools/executeTool missing (Chrome <=149 or webmcp-react <=1.0.0)",
    );
    return;
  }
  const executeTool = mc.executeTool.bind(mc);
  let legacyNative = false;
  {
    const reg = new AbortController();
    let received: unknown;
    let calls = 0;
    try {
      await mc.registerTool(
        {
          name: "input_probe",
          description: "Probe consumer input serialization.",
          execute: (input) => {
            received = input;
            calls++;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
        { signal: reg.signal },
      );
      const probe = (await mc.getTools()).find((tool) => tool.name === "input_probe");
      if (!probe) throw new Error("input_probe not listed");
      try {
        await executeTool(probe, {});
      } catch (err) {
        if (
          !isPolyfill &&
          errName(err) === "UnknownError" &&
          typeof err === "object" &&
          err !== null &&
          "message" in err &&
          typeof err.message === "string" &&
          err.message.startsWith("Failed to parse input") &&
          calls === 0
        ) {
          await executeTool(probe, "{}");
          legacyNative = true;
          log("INFO: legacy native requires JSON strings");
        } else {
          throw err;
        }
      }
      if (legacyNative) {
        log("INFO: modern input probes skipped on legacy native");
      } else {
        const transformed = { nested: { text: "serialized" } };
        const input = { toJSON: () => transformed };
        await executeTool(probe, input);
        if (isPolyfill) {
          log(
            received === input
              ? "PASS: polyfill preserves object input"
              : "FAIL: polyfill changed object input",
          );
        } else {
          log(
            received !== transformed &&
              (received as typeof transformed).nested !== transformed.nested &&
              JSON.stringify(received) === JSON.stringify(transformed)
              ? "PASS: object input serialized and cloned"
              : "FAIL: object input serialization or cloning",
          );
        }

        const defaults: [string, () => Promise<unknown>][] = [
          ["omitted input", () => executeTool(probe)],
          ["undefined input", () => executeTool(probe, undefined)],
          ["undefined input and options", () => executeTool(probe, undefined, undefined)],
        ];
        for (const [label, run] of defaults) {
          const before = calls;
          const previous = received;
          await run();
          log(
            calls === before + 1 && received !== previous && JSON.stringify(received) === "{}"
              ? `PASS: ${label} defaults to an empty object`
              : `FAIL: ${label} default`,
          );
        }

        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const nonJsonInputs: [string, object][] = [
          ["circular", circular],
          ["BigInt", { value: BigInt(1) }],
          ["toJSON undefined", { toJSON: () => undefined }],
        ];
        const invalid: [string, () => Promise<unknown>][] = [
          ["undefined with options", () => executeTool(probe, undefined, {})],
          ["null", () => executeTool(probe, null as unknown as object)],
        ];
        for (const [label, value] of nonJsonInputs) {
          if (isPolyfill) {
            const before = calls;
            await executeTool(probe, value);
            log(
              calls === before + 1 && received === value
                ? `PASS: polyfill preserves ${label} input`
                : `FAIL: polyfill changed ${label} input`,
            );
          } else {
            invalid.push([label, () => executeTool(probe, value)]);
          }
        }
        const inputError = isPolyfill ? "UnknownError" : "TypeError";
        for (const [label, run] of invalid) {
          const before = calls;
          try {
            await run();
            log(`FAIL: ${label} input resolved`);
          } catch (err) {
            log(
              errName(err) === inputError && calls === before
                ? `PASS: ${label} input rejects ${inputError} before handler`
                : `FAIL: ${label} input (${errName(err)}, handler calls: ${calls - before})`,
            );
          }
        }
      }
      const before = calls;
      try {
        await executeTool(probe, "{}");
        log(
          (isPolyfill || legacyNative) && calls === before + 1
            ? "PASS: legacy JSON string accepted"
            : "FAIL: legacy JSON string unexpectedly accepted",
        );
      } catch (err) {
        log(
          !isPolyfill && !legacyNative && errName(err) === "TypeError" && calls === before
            ? "PASS: legacy JSON string rejects TypeError"
            : `FAIL: legacy JSON string (${errName(err)})`,
        );
      }
    } finally {
      reg.abort();
    }
  }
  const inputFor = (input: object) => (legacyNative ? JSON.stringify(input) : input);
  const tools = await mc.getTools();
  const names = tools.map((x) => x.name);
  log(
    names.includes("echo") && names.includes("add") ? "PASS: getTools" : `FAIL: getTools ${names}`,
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

  const echoRaw = echoTool ? await executeTool(echoTool, inputFor({ text: "hi" })) : null;
  const echo = echoRaw ? JSON.parse(echoRaw) : null;
  log(
    echo?.content?.[0]?.text?.includes("hi") ? "PASS: executeTool echo" : `FAIL: echo ${echoRaw}`,
  );

  const addTool = tools.find((x) => x.name === "add");
  const addRaw = addTool ? await executeTool(addTool, inputFor({ a: 2, b: 3 })) : null;
  const add = addRaw ? JSON.parse(addRaw) : null;
  log(add?.content?.[0]?.text?.includes("5") ? "PASS: executeTool add" : `FAIL: add ${addRaw}`);

  // Probe: handler receives options.signal (Chrome 153.0.8007+ / polyfill 1.1.0+).
  {
    const reg = new AbortController();
    let sawSignal: unknown = "not-called";
    try {
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
      if (!probeTool) {
        log("FAIL: signal_probe not listed");
      } else {
        await executeTool(probeTool, inputFor({}));
        log(
          sawSignal instanceof AbortSignal
            ? "PASS: execute received options.signal"
            : "INFO: no options.signal (Chrome <=152)",
        );
      }
    } finally {
      reg.abort();
    }
  }

  // Probe: caller abort → tool signal aborts (generic AbortError), caller rejects.
  // The synthetic tool has a bounded 500ms fallback so a runtime that never
  // forwards a signal into execute() still settles instead of hanging this
  // self-test forever.
  {
    const reg = new AbortController();
    const controller = new AbortController();
    let toolAborted: string | null = null;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    try {
      await mc.registerTool(
        {
          name: "abort_flight_probe",
          description: "Probe mid-flight cancellation.",
          execute: (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              markStarted();
              const timer = setTimeout(() => {
                resolve({ content: [{ type: "text", text: "no-signal-timeout" }] });
                markSettled();
              }, 500);
              options?.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                toolAborted =
                  options.signal?.reason instanceof DOMException
                    ? options.signal.reason.name
                    : String(options.signal?.reason);
                reject(options.signal?.reason);
                markSettled();
              });
            }),
        },
        { signal: reg.signal },
      );
      const probeTool = (await mc.getTools()).find((x) => x.name === "abort_flight_probe");
      if (!probeTool) {
        log("FAIL: abort_flight_probe not listed");
      } else {
        const pending = executeTool(probeTool, inputFor({}), { signal: controller.signal });
        await waitForStart(started, pending);
        controller.abort(new DOMException("probe cancel", "AbortError"));
        await pending.then(
          (raw) =>
            log(
              String(raw).includes("no-signal-timeout")
                ? "INFO: aborted executeTool did not reject (no signal forwarded; Chrome <=152)"
                : `FAIL: aborted executeTool resolved (${raw})`,
            ),
          async (err: unknown) => {
            await settled;
            log(
              toolAborted
                ? `PASS: aborted executeTool rejected (caller: ${errName(err)}, tool: ${toolAborted})`
                : `INFO: aborted executeTool rejected but tool-side signal never fired (caller: ${errName(err)}; no signal forwarded; Chrome <=152)`,
            );
          },
        );
      }
    } finally {
      controller.abort();
      reg.abort();
    }
  }

  // Probe: unregister mid-flight — execution survives (Chrome 153.0.8008+ / polyfill 1.1.0+).
  {
    const reg = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    try {
      await mc.registerTool(
        {
          name: "unregister_probe",
          description: "Probe unregister-during-execution.",
          execute: () =>
            new Promise((resolve) => {
              markStarted();
              setTimeout(() => resolve({ content: [{ type: "text", text: "survived" }] }), 200);
            }),
        },
        { signal: reg.signal },
      );
      const probeTool = (await mc.getTools()).find((x) => x.name === "unregister_probe");
      if (!probeTool) {
        log("FAIL: unregister_probe not listed");
      } else {
        const pending = executeTool(probeTool, inputFor({}));
        await waitForStart(started, pending);
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
              `INFO: in-flight execution rejected on unregister (${errName(err)}; pre-153.0.8008 behavior)`,
            ),
        );
      }
    } finally {
      reg.abort();
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
    log(
      `INFO: already-aborted register RESOLVED (value=${String(result)}; pre-152 native behavior)`,
    );
  } catch (err) {
    log(`PASS: already-aborted register rejects (${errName(err)})`);
  }
}

/**
 * StatusPanel is rendered inside WebMCPProvider and uses useWebMCPStatus() to
 * reactively detect when the polyfill is installed, then attaches listeners.
 */
function StatusPanel() {
  const { available } = useWebMCPStatus();
  const [detection, setDetection] = useState<"native" | "polyfill" | "checking">("checking");
  const [toolchangeCount, setToolchangeCount] = useState(0);

  // Update detection once available
  useEffect(() => {
    if (available) {
      const mc = document.modelContext;
      setDetection(mc && "__isWebMCPPolyfill" in mc ? "polyfill" : "native");
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
    void runSelfTest((line) => setSelftestOutput((lines) => [...lines, line])).catch(
      (err: unknown) =>
        setSelftestOutput((lines) => [...lines, `FAIL: self-test (${errName(err)})`]),
    );
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
