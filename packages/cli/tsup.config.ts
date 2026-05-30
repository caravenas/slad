import { defineConfig } from "tsup";
import { builtinModules } from "node:module";

// All Node.js built-ins (both bare and node: prefixed) must stay external
// so they're resolved by the runtime, not the bundle's require shim.
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: false,
  dts: false,
  // Explicitly keep all Node.js built-ins external (resolves the
  // "Dynamic require of events is not supported" error when bundling
  // CJS packages like commander that internally do require('events')).
  external: nodeBuiltins,
  // Bundle everything else: @slad/* workspace packages + all npm deps.
  // Needed because pnpm only creates node_modules symlinks for direct deps,
  // so transitive deps like @anthropic-ai/sdk are not reachable when globally linked.
  noExternal: [/.*/],
  outDir: "dist",
});
