import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { DecisionRecord } from "@slad/shared";
import { appendSessionDecisions, readSessionDecisions } from "./decisions.js";
import { resetDocsRootCache } from "./layout.js";

function makeDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "test-decision",
    stage: "plan",
    decision: "Elegimos el enfoque A",
    alternatives: [],
    rationale: "",
    evidence: [],
    reversibility: "trivial",
    supersedes: [],
    ...overrides,
  };
}

async function withTmpDocs<T>(fn: (docsRoot: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slad-decisions-test-"));
  const original = process.env["SLAD_DOCS_PATH"];
  process.env["SLAD_DOCS_PATH"] = tmp;
  resetDocsRootCache();
  try {
    return await fn(tmp);
  } finally {
    if (original === undefined) delete process.env["SLAD_DOCS_PATH"];
    else process.env["SLAD_DOCS_PATH"] = original;
    resetDocsRootCache();
    await rm(tmp, { recursive: true, force: true });
  }
}

test("readSessionDecisions: returns empty array when no log exists", async () => {
  await withTmpDocs(async () => {
    const result = await readSessionDecisions("session-001");
    assert.deepEqual(result, []);
  });
});

test("appendSessionDecisions: no-ops for empty decisions array", async () => {
  await withTmpDocs(async (docsRoot) => {
    await appendSessionDecisions("session-001", []);
    const result = await readSessionDecisions("session-001");
    assert.deepEqual(result, []);

    // file should not have been created
    const { existsSync } = await import("node:fs");
    assert.equal(
      existsSync(path.join(docsRoot, "log", "decisions", "session-001.json")),
      false,
    );
  });
});

test("appendSessionDecisions: creates log and reads back decisions", async () => {
  await withTmpDocs(async () => {
    const d1 = makeDecision({ id: "d1", stage: "explore" });
    await appendSessionDecisions("session-abc", [d1]);

    const result = await readSessionDecisions("session-abc");
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "d1");
    assert.equal(result[0]!.stage, "explore");
  });
});

test("appendSessionDecisions: accumulates across multiple calls", async () => {
  await withTmpDocs(async () => {
    const d1 = makeDecision({ id: "d1", stage: "explore" });
    const d2 = makeDecision({ id: "d2", stage: "plan" });
    const d3 = makeDecision({ id: "d3", stage: "run" });

    await appendSessionDecisions("session-abc", [d1]);
    await appendSessionDecisions("session-abc", [d2, d3]);

    const result = await readSessionDecisions("session-abc");
    assert.equal(result.length, 3);
    assert.equal(result[0]!.id, "d1");
    assert.equal(result[1]!.id, "d2");
    assert.equal(result[2]!.id, "d3");
  });
});

test("appendSessionDecisions: sessions are isolated", async () => {
  await withTmpDocs(async () => {
    const d1 = makeDecision({ id: "d1", stage: "plan" });
    const d2 = makeDecision({ id: "d2", stage: "explore" });

    await appendSessionDecisions("session-A", [d1]);
    await appendSessionDecisions("session-B", [d2]);

    const a = await readSessionDecisions("session-A");
    const b = await readSessionDecisions("session-B");

    assert.equal(a.length, 1);
    assert.equal(a[0]!.id, "d1");
    assert.equal(b.length, 1);
    assert.equal(b[0]!.id, "d2");
  });
});

test("readSessionDecisions: returns empty array when log file is corrupt", async () => {
  await withTmpDocs(async (docsRoot) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.join(docsRoot, "log", "decisions");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "session-bad.json"), "not-json", "utf8");

    const result = await readSessionDecisions("session-bad");
    assert.deepEqual(result, []);
  });
});
