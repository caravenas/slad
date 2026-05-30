import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryProvider } from "./in-memory.js";
import { WikiMemoryProvider } from "./wiki.js";

describe("InMemoryProvider", () => {
  test("appends and queries entries by namespace", async () => {
    const mem = new InMemoryProvider();
    await mem.append({ namespace: "test", content: { value: 1 } });
    await mem.append({ namespace: "test", content: { value: 2 } });
    await mem.append({ namespace: "other", content: { value: 3 } });

    const results = await mem.query({ namespace: "test" });
    assert.equal(results.length, 2);
    assert.deepEqual((results[0]!.content as { value: number }).value, 1);
  });

  test("respects limit", async () => {
    const mem = new InMemoryProvider();
    for (let i = 0; i < 5; i++) await mem.append({ namespace: "ns", content: i });
    const results = await mem.query({ namespace: "ns", limit: 2 });
    assert.equal(results.length, 2);
  });

  test("clear removes all entries in namespace", async () => {
    const mem = new InMemoryProvider();
    await mem.append({ namespace: "a", content: "x" });
    await mem.append({ namespace: "b", content: "y" });
    await mem.clear("a");
    assert.equal((await mem.query({ namespace: "a" })).length, 0);
    assert.equal((await mem.query({ namespace: "b" })).length, 1);
  });
});

describe("WikiMemoryProvider", () => {
  let tmpDir: string;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-wiki-")); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("persists entries to LDJSON files", async () => {
    const wiki = new WikiMemoryProvider(tmpDir);
    await wiki.append({ namespace: "decisions", content: { key: "use-zod" } });
    await wiki.append({ namespace: "decisions", content: { key: "use-pnpm" } });

    const results = await wiki.query({ namespace: "decisions" });
    assert.equal(results.length, 2);

    const filePath = path.join(tmpDir, "decisions.ldjson");
    assert.ok(fs.existsSync(filePath));
  });

  test("returns empty array for unknown namespace", async () => {
    const wiki = new WikiMemoryProvider(tmpDir);
    const results = await wiki.query({ namespace: "nonexistent" });
    assert.deepEqual(results, []);
  });

  test("clear removes the LDJSON file", async () => {
    const wiki = new WikiMemoryProvider(tmpDir);
    await wiki.append({ namespace: "to-clear", content: "x" });
    await wiki.clear("to-clear");
    const results = await wiki.query({ namespace: "to-clear" });
    assert.deepEqual(results, []);
  });
});
