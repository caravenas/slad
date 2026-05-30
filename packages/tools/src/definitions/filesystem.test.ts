import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileExec, writeFileExec, listDirExec } from "./filesystem.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-fs-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readFileExec", () => {
  test("reads a file successfully", async () => {
    const file = path.join(tmpDir, "hello.txt");
    fs.writeFileSync(file, "hello world");
    const result = await readFileExec({ path: "hello.txt" }, tmpDir);
    assert.equal(result, "hello world");
  });

  test("throws on non-existent file", async () => {
    await assert.rejects(
      () => readFileExec({ path: "doesNotExist.txt" }, tmpDir),
      /no existe/i,
    );
  });

  test("blocks path traversal", async () => {
    await assert.rejects(
      () => readFileExec({ path: "../etc/passwd" }, tmpDir),
      /path traversal/i,
    );
  });

  test("truncates files over 500 lines", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(tmpDir, "big.txt"), lines);
    const result = await readFileExec({ path: "big.txt" }, tmpDir);
    assert.match(result, /TRUNCADO/);
    assert.ok(result.split("\n").length <= 201); // 200 lines + truncation message
  });
});

describe("writeFileExec", () => {
  test("writes a file", async () => {
    const result = await writeFileExec({ path: "output.txt", content: "test content" }, tmpDir);
    assert.match(result, /Escrito/);
    assert.equal(fs.readFileSync(path.join(tmpDir, "output.txt"), "utf8"), "test content");
  });

  test("creates intermediate directories", async () => {
    await writeFileExec({ path: "nested/dir/file.ts", content: "// ok" }, tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, "nested/dir/file.ts")));
  });

  test("blocks path traversal", async () => {
    await assert.rejects(
      () => writeFileExec({ path: "../evil.txt", content: "bad" }, tmpDir),
      /path traversal/i,
    );
  });
});

describe("listDirExec", () => {
  test("lists directory contents", async () => {
    fs.mkdirSync(path.join(tmpDir, "listme"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "listme/a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "listme/b.ts"), "");
    const result = await listDirExec({ path: "listme" }, tmpDir);
    assert.match(result, /a\.ts/);
    assert.match(result, /b\.ts/);
  });

  test("returns empty message for empty directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "emptydir"), { recursive: true });
    const result = await listDirExec({ path: "emptydir" }, tmpDir);
    assert.match(result, /vacío/i);
  });

  test("blocks path traversal", async () => {
    await assert.rejects(
      () => listDirExec({ path: "../../" }, tmpDir),
      /path traversal/i,
    );
  });
});
