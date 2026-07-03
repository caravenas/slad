import fs from "node:fs";
import path from "node:path";
import type { TelemetryProvider, TelemetrySpan } from "./types.js";

/**
 * Writes telemetry events and spans as LDJSON to a file.
 * Compatible with the existing AgentRunLog format.
 */
export class LDJSONTelemetry implements TelemetryProvider {
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  startSpan(name: string, meta?: Record<string, unknown>): TelemetrySpan {
    const startMs = Date.now();
    const startedAt = new Date().toISOString();
    const attributes: Record<string, unknown> = {};

    return {
      setAttribute: (key, value) => { attributes[key] = value; },
      end: (endMeta?: Record<string, unknown>) => {
        this.write({
          type: "span",
          name,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          ...meta,
          ...attributes,
          ...endMeta,
        });
      },
    };
  }

  emit(event: string, data?: Record<string, unknown>): void {
    this.write({ type: "event", event, timestamp: new Date().toISOString(), ...data });
  }

  private write(record: Record<string, unknown>): void {
    fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
  }
}
