import type { TelemetryProvider, TelemetrySpan } from "./types.js";

const noopSpan: TelemetrySpan = {
  end: () => {},
  setAttribute: () => {},
};

export const NoopTelemetry: TelemetryProvider = {
  startSpan: () => noopSpan,
  emit: () => {},
};
