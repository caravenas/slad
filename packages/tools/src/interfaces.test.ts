import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFileSystem, LocalShell } from "./index.js";
import { createToolRegistry } from "./registry.js";
import { builtinTools } from "./builtin-tools.js";
import { createNoopToolContext } from "./context.js";

describe("@slad/tools IO abstractions", () => {
  let tmpDir = "";
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-tools-iface-")); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("LocalFileSystem reads and writes relative workspace paths", async () => {
    const fsio = new LocalFileSystem(tmpDir);
    await fsio.writeFile("nested/hello.txt", "hello");
    assert.equal(await fsio.readFile("nested/hello.txt"), "hello");
    await assert.rejects(() => fsio.readFile("../escape.txt"), /path traversal/i);
  });

  test("LocalShell executes commands within cwd", async () => {
    const shell = new LocalShell(tmpDir);
    const result = await shell.exec("printf local-shell", { timeoutMs: 5000 });
    assert.equal(result.stdout, "local-shell");
    assert.equal(result.exitCode, 0);
  });

  test("tool registry can read and write files via builtin tools", async () => {
    const registry = createToolRegistry(builtinTools);
    const ctx = createNoopToolContext(tmpDir);
    await registry.call("fs.writeFile", { path: "a.txt", content: "from-registry" }, ctx);
    const out = await registry.call<{ content: string }>("fs.readFile", { path: "a.txt" }, ctx);
    assert.equal(out.content, "from-registry");
  });
});
