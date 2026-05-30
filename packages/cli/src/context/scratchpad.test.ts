import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scratchpad } from "./scratchpad.js";
import type { ToolCall, ToolResult } from "@slad/tools";

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "tc-1", name, arguments: args };
}

function makeResult(output: string, success = true): ToolResult {
  return {
    toolCallId: "tc-1",
    success,
    output,
    error: success ? undefined : output,
  };
}

describe("Scratchpad", () => {
  let tmpDir: string;
  let scratch: Scratchpad;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-scratch-test-"));
    scratch = new Scratchpad({ charThreshold: 100, lineThreshold: 5 }, "test-session", tmpDir);
  });

  after(() => {
    scratch.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retorna output completo si está bajo el threshold", () => {
    const call = makeCall("readFile", { path: "src/foo.ts" });
    const result = makeResult("short output"); // < 100 chars, < 5 lines
    const processed = scratch.processResult(call, result, 0);
    assert.equal(processed, "short output");
  });

  it("escribe al scratch y retorna summary si supera el threshold de chars", () => {
    const call = makeCall("readFile", { path: "src/big.ts" });
    // 20 lines, each 30 chars → total > 100 chars AND > 5 lines
    // The bulk of the content (lines 11+) should NOT appear in the summary preview
    const lines = Array.from({ length: 20 }, (_, i) => `// unique-content-line-${i}-end`);
    const longOutput = lines.join("\n");
    const result = makeResult(longOutput);
    const processed = scratch.processResult(call, result, 1);
    // Should contain the readFile summary prefix
    assert.ok(processed.includes("[readFile:src/big.ts]"), "debe incluir el prefijo del tool");
    // Should contain the reread hint
    assert.ok(processed.includes("readFile("), "debe incluir el hint de re-lectura");
    // Bulk content (line 15+) should NOT be in the processed summary
    assert.ok(!processed.includes("unique-content-line-15-end"), "el bulk no debe estar en el summary");
    // Entry should be written to disk
    const entry = scratch.getEntries().find((e) => e.toolName === "readFile" && e.round === 1);
    assert.ok(entry, "debe existir una entry en el scratchpad");
    assert.ok(entry!.originalSize === longOutput.length, "debe registrar el tamaño original");
  });

  it("escribe al scratch si supera el threshold de líneas", () => {
    const call = makeCall("exec", { command: "npm test" });
    const manyLines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"); // > 5 lines
    const result = makeResult(manyLines);
    const processed = scratch.processResult(call, result, 2);
    assert.ok(processed.includes("[exec:npm test]"));
  });

  it("retorna ERROR: ... si el result no es exitoso (sin ir al scratch)", () => {
    const call = makeCall("exec", { command: "bad-cmd" });
    const result = makeResult("command not found", false);
    const processed = scratch.processResult(call, result, 0);
    assert.ok(processed.startsWith("ERROR:"));
    // Errors should not go to scratch
    assert.equal(scratch.getEntries().filter((e) => e.toolName === "exec" && e.round === 0).length, 0);
  });

  it("getEntries retorna las entries creadas", () => {
    const entries = scratch.getEntries();
    assert.ok(entries.length >= 2); // readFile + exec from tests above
  });

  it("summarize para readFile incluye exports detectados", () => {
    const call = makeCall("readFile", { path: "src/index.ts" });
    const output = [
      "import { foo } from './foo.js';",
      "export function bar() {}",
      "export const baz = 1;",
      ...Array.from({ length: 30 }, (_, i) => `// line ${i}`),
    ].join("\n");
    const summary = scratch.summarize(call, output);
    assert.ok(summary.includes("Exports detectados"));
    assert.ok(summary.includes("export function bar"));
  });

  it("summarize para exec detecta errores", () => {
    const call = makeCall("exec", { command: "tsc" });
    const output = ["Compiling...", "Error: type mismatch", "done"].join("\n");
    const summary = scratch.summarize(call, output);
    assert.ok(summary.includes("CON ERRORES"));
  });

  it("summarize genérico funciona para tools desconocidos", () => {
    const call = makeCall("unknownTool", {});
    const output = Array.from({ length: 20 }, (_, i) => `result line ${i}`).join("\n");
    const summary = scratch.summarize(call, output);
    assert.ok(summary.includes("[unknownTool]"));
  });

  it("cleanup elimina el directorio de sesión", () => {
    const tempScratch = new Scratchpad({}, "cleanup-session", tmpDir);
    // Write something to force dir creation
    const call = makeCall("readFile", { path: "x.ts" });
    const result = makeResult("x".repeat(200));
    tempScratch.processResult(call, result, 0);
    const sessionDir = path.join(tmpDir, ".slad-os/scratch/cleanup-session");
    assert.ok(fs.existsSync(sessionDir));
    tempScratch.cleanup();
    assert.ok(!fs.existsSync(sessionDir));
  });
});
