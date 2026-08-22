import { useState, useEffect, useCallback } from "react";
import "./DevPanel.css";

interface ToolInfo {
  name: string;
  description: string;
  inputSchema: string;
}

interface ExecutionResult {
  toolName: string;
  input: string;
  output: string | null;
  error: string | null;
  duration: number;
  timestamp: number;
}

export function DevPanel() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("{}");
  const [results, setResults] = useState<ExecutionResult[]>([]);
  const [isOpen, setIsOpen] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const refreshTools = useCallback(async () => {
    const mc = document.modelContext;
    let listed: ToolInfo[] = [];
    if (mc?.getTools) {
      const tools = await mc.getTools();
      listed = tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Chrome <=153: string; Chrome 154+/polyfill 1.1.0: object.
        inputSchema:
          typeof t.inputSchema === "string"
            ? t.inputSchema
            : JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
      }));
    } else {
      const mct = (navigator as any).modelContextTesting;
      if (!mct) return;
      listed = mct.listTools();
    }
    setTools(listed);
    setSelectedTool((prev) => {
      if (prev && listed.some((t) => t.name === prev)) return prev;
      return listed.length > 0 ? listed[0].name : null;
    });
  }, []);

  useEffect(() => {
    refreshTools();
    const interval = setInterval(refreshTools, 2000);
    return () => clearInterval(interval);
  }, [refreshTools]);

  const selectedToolInfo = tools.find((t) => t.name === selectedTool);

  const generateSample = useCallback(() => {
    if (!selectedToolInfo) return;
    try {
      const schema = JSON.parse(selectedToolInfo.inputSchema);
      const sample: Record<string, unknown> = {};
      if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
          if (prop.type === "string") sample[key] = prop.enum ? prop.enum[0] : "example";
          else if (prop.type === "number") sample[key] = 0;
          else if (prop.type === "boolean") sample[key] = true;
          else sample[key] = null;
        }
      }
      setInputValue(JSON.stringify(sample, null, 2));
    } catch {
      // ignore parse errors
    }
  }, [selectedToolInfo]);

  const handleExecute = async () => {
    if (!selectedTool) return;

    const controller = new AbortController();
    setAbortController(controller);
    setIsExecuting(true);
    const start = performance.now();

    try {
      JSON.parse(inputValue); // validate
      const mc = document.modelContext;
      let raw: string | null;
      if (mc?.getTools && mc.executeTool) {
        const listed = await mc.getTools();
        const tool = listed.find((t) => t.name === selectedTool);
        if (!tool) throw new Error(`Tool "${selectedTool}" is no longer registered`);
        raw = await mc.executeTool(tool, inputValue, { signal: controller.signal });
      } else {
        raw = await (navigator as any).modelContextTesting.executeTool(selectedTool, inputValue, {
          signal: controller.signal,
        });
      }
      const duration = performance.now() - start;
      setResults((prev) => [
        {
          toolName: selectedTool,
          input: inputValue,
          output: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2),
          error: null,
          duration,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
    } catch (err: any) {
      const duration = performance.now() - start;
      setResults((prev) => [
        {
          toolName: selectedTool,
          input: inputValue,
          output: null,
          error: err.message || String(err),
          duration,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
    } finally {
      setAbortController(null);
      setIsExecuting(false);
    }
  };

  if (!isOpen) {
    return (
      <button className="devpanel-toggle" onClick={() => setIsOpen(true)}>
        DevPanel
      </button>
    );
  }

  return (
    <aside className="devpanel">
      <div className="devpanel-header">
        <h3>DevPanel</h3>
        <div className="devpanel-header-actions">
          <button onClick={refreshTools}>Refresh</button>
          <button onClick={() => setIsOpen(false)}>_</button>
        </div>
      </div>

      <section className="devpanel-tools">
        <h4>Tools ({tools.length})</h4>
        {tools.length === 0 ? (
          <p className="devpanel-empty">No tools registered</p>
        ) : (
          <ul className="devpanel-tool-list">
            {tools.map((tool) => (
              <li
                key={tool.name}
                className={tool.name === selectedTool ? "selected" : ""}
                onClick={() => setSelectedTool(tool.name)}
              >
                <strong>{tool.name}</strong>
                <span>{tool.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedToolInfo && (
        <section className="devpanel-execute">
          <h4>{selectedToolInfo.name}</h4>
          <p className="devpanel-desc">{selectedToolInfo.description}</p>

          <details>
            <summary>Input Schema</summary>
            <pre>{JSON.stringify(JSON.parse(selectedToolInfo.inputSchema), null, 2)}</pre>
          </details>

          <div className="devpanel-input">
            <div className="devpanel-input-header">
              <label>Input JSON</label>
              <button onClick={generateSample}>Sample</button>
            </div>
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              rows={6}
              spellCheck={false}
            />
          </div>

          <div className="devpanel-run-row">
            <button className="devpanel-run" onClick={handleExecute} disabled={isExecuting}>
              {isExecuting ? "Executing..." : "Execute"}
            </button>
            {isExecuting && (
              <button
                className="devpanel-cancel"
                onClick={() => abortController?.abort(new DOMException("Cancelled from DevPanel", "AbortError"))}
              >
                Cancel
              </button>
            )}
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section className="devpanel-results">
          <div className="devpanel-results-header">
            <h4>Results</h4>
            <button onClick={() => setResults([])}>Clear</button>
          </div>
          {results.map((r, i) => (
            <div key={r.timestamp} className={`devpanel-result ${r.error ? "error" : "success"}`}>
              <div className="devpanel-result-meta">
                <span className="devpanel-result-tool">{r.toolName}</span>
                <span className="devpanel-result-time">{r.duration.toFixed(0)}ms</span>
              </div>
              <details open={i === 0}>
                <summary>{r.error ? "Error" : "Output"}</summary>
                <pre>{r.error || r.output}</pre>
              </details>
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}
