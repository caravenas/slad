// ─── TelemetryProvider contract ───────────────────────────────────────────────

export interface TelemetrySpan {
  end(meta?: Record<string, unknown>): void;
  setAttribute(key: string, value: unknown): void;
}

export interface TelemetryProvider {
  /** Start a named span (returns a span that must be ended) */
  startSpan(name: string, meta?: Record<string, unknown>): TelemetrySpan;
  /** Emit a point-in-time event */
  emit(event: string, data?: Record<string, unknown>): void;
}
