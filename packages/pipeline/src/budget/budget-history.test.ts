import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendBudgetHistory,
  readBudgetHistory,
  summarizeBudgetHistory,
  type BudgetHistoryEntry,
} from "./budget-history.js";

describe("Budget history", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-budget-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function entry(overrides: Partial<BudgetHistoryEntry> = {}): BudgetHistoryEntry {
    return {
      sessionId: "session-abc",
      intent: "añadir función sum",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.0108,
      stagesCompleted: ["explore", "snapshot", "plan"],
      ...overrides,
    };
  }

  it("readBudgetHistory returns empty array when no file exists", () => {
    const entries = readBudgetHistory(tmpDir);
    assert.deepEqual(entries, []);
  });

  it("appendBudgetHistory creates .slad-os dir and JSONL file", () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-bh-fresh-"));
    try {
      appendBudgetHistory(entry(), freshDir);
      const filePath = path.join(freshDir, ".slad-os", "budget-history.jsonl");
      assert.ok(fs.existsSync(filePath), "budget-history.jsonl debe existir");
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("appendBudgetHistory writes a valid JSON line per call", () => {
    appendBudgetHistory(entry({ sessionId: "s1", inputTokens: 100 }), tmpDir);
    appendBudgetHistory(entry({ sessionId: "s2", inputTokens: 200 }), tmpDir);

    const entries = readBudgetHistory(tmpDir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.sessionId, "s1");
    assert.equal(entries[0]!.inputTokens, 100);
    assert.equal(entries[1]!.sessionId, "s2");
    assert.equal(entries[1]!.inputTokens, 200);
  });

  it("readBudgetHistory skips malformed lines silently", () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-bh-bad-"));
    try {
      const filePath = path.join(freshDir, ".slad-os", "budget-history.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `{invalid json}\n${JSON.stringify(entry())}\n`, "utf8");

      const entries = readBudgetHistory(freshDir);
      assert.equal(entries.length, 1);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("summarizeBudgetHistory returns zeros for empty list", () => {
    const summary = summarizeBudgetHistory([]);
    assert.equal(summary.totalRuns, 0);
    assert.equal(summary.totalInputTokens, 0);
    assert.equal(summary.totalOutputTokens, 0);
    assert.equal(summary.totalEstimatedCostUsd, 0);
  });

  it("summarizeBudgetHistory aggregates all entries", () => {
    const entries: BudgetHistoryEntry[] = [
      entry({ inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.01 }),
      entry({ inputTokens: 2000, outputTokens: 1000, estimatedCostUsd: 0.02 }),
    ];
    const summary = summarizeBudgetHistory(entries);
    assert.equal(summary.totalRuns, 2);
    assert.equal(summary.totalInputTokens, 3000);
    assert.equal(summary.totalOutputTokens, 1500);
    assert.ok(Math.abs(summary.totalEstimatedCostUsd - 0.03) < 0.0001);
  });
});
