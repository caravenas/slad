// Suppress DEP0040 (punycode) emitted by transitive deps during dev startup.
// This must run before importing cli.ts so warnings are filtered early.
//
// `process.emit` has a large overloaded signature that varies across @types/node
// versions, so we widen it to a single, version-agnostic shape via `unknown` casts.
type ProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

const originalEmit = process.emit.bind(process) as unknown as ProcessEmit;

const patchedEmit: ProcessEmit = (event, ...args) => {
  if (event === "warning" && (args[0] as { code?: string } | undefined)?.code === "DEP0040") {
    return false;
  }
  return originalEmit(event, ...args);
};

process.emit = patchedEmit as unknown as typeof process.emit;

await import("./cli.js");
