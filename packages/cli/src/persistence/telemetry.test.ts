import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { AgentRunLog } from "@slad/shared";
import { appendAgentRunLog, readAgentRunLog } from "./telemetry.js";
import { resetDocsRootCache } from "./layout.js";

function makeEntry(overrides: Partial<AgentRunLog> = {}): AgentRunLog {
  const now = new Date().toISOString();
  return {
    sessionId: "session-test",
    intent: "test intent",
    startedAt: now,
    completedAt: now,
    durationMs: 1234,
    commandUsed: "work",
    stagesCompleted: ["explore", "snapshot", "plan"],
    debateUsed: false,
    ...overrides,
  };
}

async function withTmpDocs<T>(fn: (docsRoot: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slad-telemetry-test-"));
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

test("readAgentRunLog: returns empty array when no file exists", async () => {
  await withTmpDocs(async () => {
    const result = await readAgentRunLog();
    assert.deepEqual(result, []);
  });
});

test("appendAgentRunLog: creates file and reads back entry", async () => {
  await withTmpDocs(async () => {
    const entry = makeEntry({ sessionId: "s1", commandUsed: "ask" });
    await appendAgentRunLog(entry);

    const result = await readAgentRunLog();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.sessionId, "s1");
    assert.equal(result[0]!.commandUsed, "ask");
  });
});

test("appendAgentRunLog: accumulates multiple entries in order", async () => {
  await withTmpDocs(async () => {
    await appendAgentRunLog(makeEntry({ sessionId: "s1", intent: "first" }));
    await appendAgentRunLog(makeEntry({ sessionId: "s2", intent: "second" }));
    await appendAgentRunLog(makeEntry({ sessionId: "s3", intent: "third" }));

    const result = await readAgentRunLog();
    assert.equal(result.length, 3);
    assert.equal(result[0]!.intent, "first");
    assert.equal(result[1]!.intent, "second");
    assert.equal(result[2]!.intent, "third");
  });
});

test("appendAgentRunLog: persists optional fields correctly", async () => {
  await withTmpDocs(async () => {
    const entry = makeEntry({
      sessionId: "s1",
      commandUsed: "work-debate",
      debateUsed: true,
      debateConsensusScores: { explore: 0.85, plan: 0.72 },
      classifierResult: {
        suggestedMode: "work-debate",
        confidence: 0.91,
        rationale: "complex architecture decision",
        shownToUser: true,
        userAccepted: true,
      },
      pipelineStatus: "completed",
      estimatedCostUsd: 0.042,
    });
    await appendAgentRunLog(entry);

    const result = await readAgentRunLog();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.debateUsed, true);
    assert.equal(result[0]!.debateConsensusScores?.explore, 0.85);
    assert.equal(result[0]!.debateConsensusScores?.plan, 0.72);
    assert.equal(result[0]!.classifierResult?.suggestedMode, "work-debate");
    assert.equal(result[0]!.pipelineStatus, "completed");
    assert.ok(Math.abs((result[0]!.estimatedCostUsd ?? 0) - 0.042) < 0.001);
  });
});

test("readAgentRunLog: skips corrupt lines, returns valid entries", async () => {
  await withTmpDocs(async (docsRoot) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.join(docsRoot, "log", "telemetry");
    await mkdir(dir, { recursive: true });

    const validEntry = makeEntry({ sessionId: "valid" });
    const lines = [
      JSON.stringify(validEntry),
      "not-json-at-all",
      JSON.stringify({ broken: true }),  // valid JSON but invalid schema
      JSON.stringify(makeEntry({ sessionId: "also-valid" })),
    ].join("\n") + "\n";

    await writeFile(path.join(dir, "agent-run-log.ldjson"), lines, "utf8");

    const result = await readAgentRunLog();
    assert.equal(result.length, 2);
    assert.equal(result[0]!.sessionId, "valid");
    assert.equal(result[1]!.sessionId, "also-valid");
  });
});
