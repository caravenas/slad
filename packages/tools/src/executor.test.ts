import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { ToolExecutor } from "./executor.js";
import { createToolRegistry } from "./registry.js";
import { builtinTools } from "./builtin-tools.js";
import type { ApprovalGate } from "./types.js";

// ─── Mock harness ─────────────────────────────────────────────────────────────

function makeHarness(requiresApprovalResult: boolean): ApprovalGate {
  return {
    requiresApproval: () => requiresApprovalResult,
  };
}

const cwd = os.tmpdir();

describe("ToolExecutor", () => {
  test("executes a shell tool without harness", async () => {
    const registry = createToolRegistry(builtinTools);
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const result = await executor.execute({
      id: "call-1",
      name: "shell.exec",
      arguments: { command: "echo hello-from-test" },
    });
    assert.ok(result.success, `Expected success but got error: ${result.error}`);
    assert.match(result.output, /hello-from-test/);
  });

  test("returns error for unknown tool", async () => {
    const registry = createToolRegistry(builtinTools);
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const result = await executor.execute({
      id: "call-2",
      name: "nonExistentTool",
      arguments: {},
    });
    assert.ok(!result.success);
    assert.match(result.error ?? "", /no encontrada/i);
  });

  test("blocks dangerous tool in dryRun mode", async () => {
    const registry = createToolRegistry(builtinTools);
    const harness = makeHarness(true); // always requires approval
    const executor = new ToolExecutor(registry, { cwd, harness, dryRun: true });
    const result = await executor.execute({
      id: "call-3",
      name: "shell.exec",
      arguments: { command: "rm -rf /tmp/test-xyz" },
    });
    assert.ok(!result.success);
    assert.match(result.error ?? "", /dry-run/i);
  });

  test("path traversal is caught at the tool level", async () => {
    const registry = createToolRegistry(builtinTools);
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const result = await executor.execute({
      id: "call-4",
      name: "fs.readFile",
      arguments: { path: "../../../etc/passwd" },
    });
    assert.ok(!result.success);
    assert.match(result.error ?? "", /path traversal/i);
  });

  test("safe command runs without harness approval", async () => {
    const registry = createToolRegistry(builtinTools);
    const harness = makeHarness(false); // does not require approval
    const executor = new ToolExecutor(registry, { cwd, harness });
    const result = await executor.execute({
      id: "call-5",
      name: "shell.exec",
      arguments: { command: "echo safe" },
    });
    assert.ok(result.success);
  });
});
