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
  const t = navigator.modelContextTesting;
  if (!t) {
    log("FAIL: navigator.modelContextTesting missing");
    return;
  }
  const names = t.listTools().map((x) => x.name);
  log(
    names.includes("echo") && names.includes("add")
      ? "PASS: listTools"
      : `FAIL: listTools ${names}`,
  );
  const echoRaw = await t.executeTool("echo", JSON.stringify({ text: "hi" }));
  const echo = echoRaw ? JSON.parse(echoRaw) : null;
  log(
    echo?.content?.[0]?.text?.includes("hi")
      ? "PASS: execute echo"
      : `FAIL: echo ${echoRaw}`,
  );
  const addRaw = await t.executeTool("add", JSON.stringify({ a: 2, b: 3 }));
  const add = addRaw ? JSON.parse(addRaw) : null;
  log(
    add?.content?.[0]?.text?.includes("5")
      ? "PASS: execute add"
      : `FAIL: add ${addRaw}`,
  );
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
