import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveSession } from "./session.js";
import { computeStatsFromSessions, getProjectStats, summarizeTelemetry } from "./stats.js";
import type { SessionState } from "./types.js";
import type { AgentRunLog } from "@slad/shared";
import { resetDocsRootCache } from "../persistence/layout.js";

const originalDocsPath = process.env.SLAD_DOCS_PATH;

test.beforeEach(() => {
  delete process.env.SLAD_DOCS_PATH;
  resetDocsRootCache();
});

test.afterEach(() => {
  if (originalDocsPath === undefined) {
    delete process.env.SLAD_DOCS_PATH;
  } else {
    process.env.SLAD_DOCS_PATH = originalDocsPath;
  }
  resetDocsRootCache();
});

function session(id: string, artifactKinds: SessionState["artifacts"][number]["kind"][]): SessionState {
  return {
    id,
    createdAt: "2026-05-06T00:00:00.000Z",
    intent: `Intent ${id}`,
    artifacts: artifactKinds.map((kind, index) => ({
      kind,
      path: `sessions/${id}/artifacts/${index}.json`,
      createdAt: "2026-05-06T00:00:00.000Z",
    })),
    humanAnswers: [],
    notes: [],
  };
}

test("computeStatsFromSessions counts sessions, run artifacts, and learn artifacts", () => {
  const stats = computeStatsFromSessions([
    session("s1", ["explore", "run", "learn"]),
    session("s2", ["run", "run", "plan"]),
    session("s3", ["learn", "evolve"]),
  ]);

  assert.deepEqual(stats, {
    sessions: 3,
    runs: 3,
    learnings: 2,
  });
});

test("computeStatsFromSessions returns zero totals for an empty project", () => {
  assert.deepEqual(computeStatsFromSessions([]), {
    sessions: 0,
    runs: 0,
    learnings: 0,
  });
});

test("getProjectStats aggregates persisted sessions from an isolated cwd", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-stats-"));
  try {
    saveSession(session("s1", ["run", "learn", "snapshot"]), cwd);
    saveSession(session("s2", ["plan", "run", "evolve", "learn"]), cwd);

    const stats = getProjectStats(cwd);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.runs, 2);
    assert.equal(stats.learnings, 2);
    // No budget history written → zeros
    assert.deepEqual(stats.budget, {
      totalRuns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── summarizeTelemetry ────────────────────────────────────────────────────────

function makeLogEntry(overrides: Partial<AgentRunLog> = {}): AgentRunLog {
  const now = new Date().toISOString();
  return {
    sessionId: "s1",
    intent: "test",
    startedAt: now,
    completedAt: now,
    durationMs: 5000,
    commandUsed: "work",
    stagesCompleted: ["explore", "snapshot", "plan", "run"],
    debateUsed: false,
    ...overrides,
  };
}

test("summarizeTelemetry: returns zeroes for empty input", () => {
  const result = summarizeTelemetry([]);
  assert.equal(result.totalRuns, 0);
  assert.deepEqual(result.byCommand, { ask: 0, work: 0, "work-debate": 0 });
  assert.equal(result.avgDebateConsensus, null);
  assert.equal(result.avgDurationMs, null);
});

test("summarizeTelemetry: counts commands correctly", () => {
  const entries = [
    makeLogEntry({ commandUsed: "ask" }),
    makeLogEntry({ commandUsed: "ask" }),
    makeLogEntry({ commandUsed: "work" }),
    makeLogEntry({ commandUsed: "work-debate", debateUsed: true }),
  ];
  const result = summarizeTelemetry(entries);
  assert.equal(result.totalRuns, 4);
  assert.equal(result.byCommand.ask, 2);
  assert.equal(result.byCommand.work, 1);
  assert.equal(result.byCommand["work-debate"], 1);
});

test("summarizeTelemetry: counts pipeline statuses", () => {
  const entries = [
    makeLogEntry({ pipelineStatus: "completed" }),
    makeLogEntry({ pipelineStatus: "completed" }),
    makeLogEntry({ pipelineStatus: "partial" }),
    makeLogEntry({ pipelineStatus: "failed" }),
    makeLogEntry({ pipelineStatus: undefined }),
  ];
  const result = summarizeTelemetry(entries);
  assert.equal(result.byStatus.completed, 2);
  assert.equal(result.byStatus.partial, 1);
  assert.equal(result.byStatus.failed, 1);
  assert.equal(result.byStatus.unknown, 1);
});

test("summarizeTelemetry: computes average debate consensus from stage scores", () => {
  const entries = [
    makeLogEntry({ debateUsed: true, debateConsensusScores: { explore: 0.8, plan: 0.6 } }),
    makeLogEntry({ debateUsed: true, debateConsensusScores: { explore: 0.9 } }),
    makeLogEntry({ debateUsed: false }),
  ];
  const result = summarizeTelemetry(entries);
  assert.equal(result.debateRuns, 2);
  // (0.8 + 0.6 + 0.9) / 3 = 0.7666...
  assert.ok(result.avgDebateConsensus !== null);
  assert.ok(Math.abs(result.avgDebateConsensus - (0.8 + 0.6 + 0.9) / 3) < 0.001);
});

test("summarizeTelemetry: tracks classifier shown and accepted counts", () => {
  const entries = [
    makeLogEntry({ classifierResult: { suggestedMode: "ask", confidence: 0.9, rationale: "r", shownToUser: true, userAccepted: true } }),
    makeLogEntry({ classifierResult: { suggestedMode: "ask", confidence: 0.9, rationale: "r", shownToUser: true, userAccepted: false } }),
    makeLogEntry({ classifierResult: { suggestedMode: "work-debate", confidence: 0.85, rationale: "r", shownToUser: false, userAccepted: false } }),
    makeLogEntry({}),  // no classifier
  ];
  const result = summarizeTelemetry(entries);
  assert.equal(result.classifierShown, 2);
  assert.equal(result.classifierAccepted, 1);
});

test("summarizeTelemetry: computes average duration", () => {
  const entries = [
    makeLogEntry({ durationMs: 4000 }),
    makeLogEntry({ durationMs: 6000 }),
    makeLogEntry({ durationMs: 8000 }),
  ];
  const result = summarizeTelemetry(entries);
  assert.ok(result.avgDurationMs !== null);
  assert.ok(Math.abs(result.avgDurationMs - 6000) < 1);
});

test("getProjectStats includes budget totals from budget-history.jsonl", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-stats-budget-"));
  try {
    const { appendBudgetHistory } = await import("@slad/context-budget");
    appendBudgetHistory({
      sessionId: "s1", intent: "x", startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z", model: "m", provider: "p",
      inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.01,
      stagesCompleted: ["explore"],
    }, cwd);

    const stats = getProjectStats(cwd);
    assert.equal(stats.budget.totalRuns, 1);
    assert.equal(stats.budget.totalInputTokens, 1000);
    assert.equal(stats.budget.totalOutputTokens, 500);
    assert.ok(Math.abs(stats.budget.totalEstimatedCostUsd - 0.01) < 0.0001);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
