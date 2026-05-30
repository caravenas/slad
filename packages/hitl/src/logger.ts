import kleur from "kleur";
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
export function createLogger(opts: { level?: LogLevel; timestamps?: boolean } = {}) {
  const minLevel: LogLevel = opts.level ?? (process.env.SLAD_LOG_LEVEL as LogLevel) ?? "info";
  const showTimestamps = opts.timestamps ?? !!process.env.SLAD_LOG_TIMESTAMPS;
  const shouldLog = (level: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
  const prefix = () => showTimestamps ? kleur.dim(`[${new Date().toISOString().slice(11, 23)}] `) : "";
  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => { if (shouldLog("debug")) console.log(prefix() + kleur.dim("· " + msg) + (ctx ? kleur.dim(` ${JSON.stringify(ctx)}`) : "")); },
    info: (msg: string) => { if (shouldLog("info")) console.log(prefix() + kleur.cyan("›") + " " + msg); },
    success: (msg: string) => { if (shouldLog("info")) console.log(prefix() + kleur.green("✓") + " " + msg); },
    warn: (msg: string) => { if (shouldLog("warn")) console.warn(prefix() + kleur.yellow("⚠") + " " + msg); },
    error: (msg: string, err?: Error) => { if (shouldLog("error")) { console.error(prefix() + kleur.red("✗") + " " + msg); if (process.env.SLAD_DEBUG === "1" && err?.stack) console.error(kleur.dim(err.stack)); } },
    dim: (msg: string) => { if (shouldLog("info")) console.log(kleur.gray(msg)); },
    title: (msg: string) => { if (shouldLog("info")) console.log("\n" + kleur.bold().white(msg)); },
    structured: (event: string, data: Record<string, unknown>) => { if (shouldLog("debug")) console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })); },
  };
}
export const log = createLogger();
export type Logger = ReturnType<typeof createLogger>;
