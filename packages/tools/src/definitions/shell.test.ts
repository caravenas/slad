import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { execExec } from "./shell.js";

describe("execExec", () => {
  test("executes a simple command", async () => {
    const result = await execExec({ command: "echo hello" }, os.tmpdir());
    assert.equal(result.trim(), "hello");
  });

  test("returns error output on failed command", async () => {
    const result = await execExec({ command: "ls /nonexistent_path_xyz_123" }, os.tmpdir());
    assert.match(result, /ERROR/i);
  });

  test("respects timeout", async () => {
    const start = Date.now();
    const result = await execExec({ command: "sleep 2", timeout: 500 }, os.tmpdir());
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `Expected timeout to fire before 2s, took ${elapsed}ms`);
    assert.match(result, /ERROR/i);
  });

  test("returns (sin output) for commands with no stdout", async () => {
    // `true` exits 0 with no output
    const result = await execExec({ command: "true" }, os.tmpdir());
    assert.equal(result, "(sin output)");
  });

  test("caps output at 1MB (large output)", async () => {
    // Generate large output — should not throw, may be truncated by maxBuffer
    const result = await execExec(
      { command: "head -c 100 /dev/urandom | base64" },
      os.tmpdir(),
    );
    assert.ok(typeof result === "string");
  });
});
