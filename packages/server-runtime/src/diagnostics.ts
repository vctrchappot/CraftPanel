export interface RuntimeDiagnostic {
  component: "client" | "service";
  reason: string;
  code?: string;
}

export type RuntimeDiagnosticSink = (diagnostic: RuntimeDiagnostic) => void;

/** Never log frame contents, tokens, console commands or exception messages. */
export function runtimeReporter(component: RuntimeDiagnostic["component"], sink: RuntimeDiagnosticSink = (entry) => {
  console.warn(`[CraftPanel runtime ${entry.component}] ${entry.reason}${entry.code ? ` (${entry.code})` : ""}`);
}) {
  let windowStart = 0;
  let count = 0;
  return (reason: string, error?: unknown) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
    if (count++ >= 10) return;
    const code = (error as { code?: unknown } | null)?.code;
    try { sink({ component, reason, ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}) }); }
    catch { /* Diagnostics must never change transport or process ownership. */ }
  };
}
