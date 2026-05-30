import kleur from "kleur";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

interface LoggerOptions {
  level?: LogLevel;
  timestamps?: boolean;
}

function createLogger(opts: LoggerOptions = {}) {
  const minLevel: LogLevel =
    (opts.level ?? (process.env.SLAD_LOG_LEVEL as LogLevel) ?? "info");
  const showTimestamps = opts.timestamps ?? !!process.env.SLAD_LOG_TIMESTAMPS;

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
  }

  function prefix(): string {
    return showTimestamps
      ? kleur.dim(`[${new Date().toISOString().slice(11, 23)}] `)
      : "";
  }

  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => {
      if (!shouldLog("debug")) return;
      const ctxStr = ctx ? kleur.dim(` ${JSON.stringify(ctx)}`) : "";
      console.log(prefix() + kleur.dim("· " + msg) + ctxStr);
    },

    info: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log(prefix() + kleur.cyan("›") + " " + msg);
    },

    success: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log(prefix() + kleur.green("✓") + " " + msg);
    },

    warn: (msg: string) => {
      if (!shouldLog("warn")) return;
      console.warn(prefix() + kleur.yellow("⚠") + " " + msg);
    },

    error: (msg: string, err?: Error) => {
      if (!shouldLog("error")) return;
      console.error(prefix() + kleur.red("✗") + " " + msg);
      if (err?.cause) {
        console.error(
          prefix() + kleur.dim(`  cause: ${(err.cause as Error).message}`),
        );
      }
      if (process.env.SLAD_DEBUG === "1" && err?.stack) {
        console.error(kleur.dim(err.stack));
      }
    },

    // Backward-compat with original API
    dim: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log(kleur.gray(msg));
    },

    title: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log("\n" + kleur.bold().white(msg));
    },

    // Structured logging for debugging
    structured: (event: string, data: Record<string, unknown>) => {
      if (!shouldLog("debug")) return;
      console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    },
  };
}

export const log = createLogger();

export { createLogger };
export type Logger = ReturnType<typeof createLogger>;
