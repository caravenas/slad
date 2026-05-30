#!/usr/bin/env node
// Thin shim so the published CLI works after `npm run build`.
// In dev you can use `npm run dev -- explore "..."` which uses tsx.
import("../dist/cli.js").catch((err) => {
  console.error("slad: failed to start. Did you run `npm run build`?");
  console.error(err);
  process.exit(1);
});
