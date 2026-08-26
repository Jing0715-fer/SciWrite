/**
 * Minimal structured logger.
 *
 * Emits single-line JSON to stdout/stderr so a process manager (or `docker
 * logs`) can grep/filter without parsing ad-hoc `[tag] +123ms ...` strings.
 * Levels are controlled by LOG_LEVEL (default "info"); setting it to "warn"
 * or "error" silences the chatty debug/info telemetry from the pipelines.
 *
 * Usage:
 *   const log = logger("generate-full-v2");
 *   log.info("section generated", { section: title, ms: 1234 });
 *   → {"level":"info","scope":"generate-full-v2","msg":"section generated","section":"...","ms":1234,"ts":"..."}
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentThreshold(): number {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVEL_ORDER[(raw as LogLevel)] ?? LEVEL_ORDER.info;
}

function emit(level: LogLevel, scope: string, msg: string, ctx?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < currentThreshold()) return;
  const line = JSON.stringify({
    level,
    scope,
    msg,
    ...(ctx ?? {}),
    ts: new Date().toISOString(),
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", scope, msg, ctx),
    info: (msg: string, ctx?: Record<string, unknown>) => emit("info", scope, msg, ctx),
    warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", scope, msg, ctx),
    error: (msg: string, ctx?: Record<string, unknown>) => emit("error", scope, msg, ctx),
  };
}
