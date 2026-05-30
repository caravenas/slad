#!/usr/bin/env node
// Suppress DEP0040 (punycode) emitted by transitive deps (uri-js → ajv → SDK)
// before any module is loaded so the warning never reaches stderr.
const _origEmit = process.emit.bind(process);
process.emit = function (event, ...args) {
  if (event === "warning" && args[0]?.code === "DEP0040") return false;
  return _origEmit(event, ...args);
};

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
await import(resolve(__dirname, "../dist/cli.js"));
