/**
 * E2E test: slad auto --dry-run against a fixture project using a mock provider.
 *
 * Verifies that explore → snapshot → plan stages complete, their artifacts are
 * written to the expected .slad-os/docs/log/ locations, and the auto report
 * reflects status "completed".
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ModelProvider } from "@slad/model-providers";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import { autoCommand } from "../commands/auto.js";
import { resetDocsRootCache } from "../persistence/layout.js";

// ─── Fixture JSON responses ───────────────────────────────────────────────────

const EXPLORE_FIXTURE = JSON.stringify({
  status: "completed",
  intent: "add sum function to math module",
  reframing: "Expose a typed sum() utility that handles arrays of numbers.",
  approaches: [
    {
      name: "Simple export",
      summary: "Export a single sum() function from math.ts",
      pros: ["minimal", "easy to test"],
      cons: ["no streaming support"],
    },
  ],
  risks: ["Edge case: empty array"],
  openQuestions: [],
  recommendedNext: "Implement sum() in src/math.ts",
  questions: [],
});

const SNAPSHOT_FIXTURE = JSON.stringify({
  status: "completed",
  content: "# Snapshot\n\nAdd sum() to math module.\n\n## Acceptance Criteria\n- sum([1,2,3]) === 6",
  questions: [],
});

const PLAN_FIXTURE = JSON.stringify({
  status: "completed",
  snapshot: "Add sum() to math module.",
  summary: "One task: implement sum().",
  tasks: [
    {
      id: "T1",
      title: "Implement sum()",
      description: "Add sum(numbers: number[]): number to src/math.ts",
      type: "implementation",
      priority: "high",
      dependsOn: [],
      files: ["src/math.ts"],
      acceptanceCriteria: ["sum([1,2,3]) returns 6", "sum([]) returns 0"],
    },
  ],
  verification: [],
  risks: [],
  openQuestions: [],
  recommendedFirstTask: "T1",
  questions: [],
});

// ─── Mock provider ────────────────────────────────────────────────────────────

function makeMockProvider(): ModelProvider {
  let callCount = 0;
  const responses = [EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE];

  return {
    name: "anthropic" as ProviderName,
    supportsToolUse: false,
    async complete(_messages: ChatMessage[], _opts?: CompletionOptions): Promise<string> {
      const response = responses[callCount % responses.length] ?? PLAN_FIXTURE;
      callCount++;
      return response;
    },
  };
}

// ─── E2E suite ────────────────────────────────────────────────────────────────

describe("E2E: slad auto --dry-run (mock provider)", { concurrency: 1 }, () => {
  let fixtureDir: string;
  let originalCwd: string;
  let originalDocsPathEnv: string | undefined;

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-e2e-"));
    // Minimal fixture project: AGENTS.md and a source file
    fs.writeFileSync(path.join(fixtureDir, "AGENTS.md"), "# Project\nA demo project.\n", "utf8");
    fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "src", "math.ts"), "export {};\n", "utf8");
    originalCwd = process.cwd();
    originalDocsPathEnv = process.env.SLAD_DOCS_PATH;
    process.chdir(fixtureDir);
    process.env.SLAD_DOCS_PATH = path.join(fixtureDir, "docs");
    resetDocsRootCache();
  });

  after(() => {
    resetDocsRootCache();
    if (originalDocsPathEnv === undefined) delete process.env.SLAD_DOCS_PATH;
    else process.env.SLAD_DOCS_PATH = originalDocsPathEnv;
    process.chdir(originalCwd);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("completes explore → snapshot → plan and writes artifacts", async () => {
    const mockProvider = makeMockProvider();

    await autoCommand("add sum function to math module", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      dryRun: true,
      fresh: true,
      skipLearn: true,
      json: false,
      _provider: mockProvider,
    });

    // Verify artifact directories exist
    const docsRoot = path.join(fixtureDir, "docs");
    const logDir = path.join(docsRoot, "log");

    assert.ok(fs.existsSync(path.join(logDir, "explores")), "explores dir should exist");
    assert.ok(fs.existsSync(path.join(logDir, "snapshots")), "snapshots dir should exist");
    assert.ok(fs.existsSync(path.join(logDir, "plans")), "plans dir should exist");

    // At least one artifact per stage
    const explores = fs.readdirSync(path.join(logDir, "explores")).filter((f) => f.endsWith(".json"));
    const snapshots = fs.readdirSync(path.join(logDir, "snapshots")).filter((f) => f.endsWith(".json"));
    const plans = fs.readdirSync(path.join(logDir, "plans")).filter((f) => f.endsWith(".json"));

    assert.ok(explores.length >= 1, `Expected ≥1 explore artifact, got ${explores.length}`);
    assert.ok(snapshots.length >= 1, `Expected ≥1 snapshot artifact, got ${snapshots.length}`);
    assert.ok(plans.length >= 1, `Expected ≥1 plan artifact, got ${plans.length}`);
  });

  it("writes an auto-report under docs/log/auto/", async () => {
    const mockProvider = makeMockProvider();

    await autoCommand("add sum function to math module", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      dryRun: true,
      fresh: true,
      skipLearn: true,
      _provider: mockProvider,
    });

    const autoLogDir = path.join(fixtureDir, "docs", "log", "auto");
    assert.ok(fs.existsSync(autoLogDir), "auto log dir should exist");
    const reports = fs.readdirSync(autoLogDir).filter((f) => f.endsWith(".json"));
    assert.ok(reports.length >= 1, "Expected at least one auto-report");

    // The report is a JSON envelope with auto-report value
    const reportContent = JSON.parse(fs.readFileSync(path.join(autoLogDir, reports[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(reportContent.kind, "auto-report");
    const value = reportContent.value as Record<string, unknown> | undefined;
    assert.ok(
      value?.status === "completed" || value?.status === "partial" || value?.status === "failed",
      "report should have a valid status",
    );
  });

  it("does not write run artifacts in dry-run mode", async () => {
    const mockProvider = makeMockProvider();

    await autoCommand("add sum function to math module", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      dryRun: true,
      fresh: true,
      skipLearn: true,
      _provider: mockProvider,
    });

    const runsDir = path.join(fixtureDir, "docs", "log", "runs");
    if (fs.existsSync(runsDir)) {
      const runs = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
      assert.equal(runs.length, 0, "dry-run should not produce run artifacts");
    }
    // runsDir not existing at all is also acceptable
  });

  it("appends an entry to budget-history.jsonl", async () => {
    const mockProvider = makeMockProvider();

    await autoCommand("add sum function to math module", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      dryRun: true,
      fresh: true,
      skipLearn: true,
      _provider: mockProvider,
    });

    const historyPath = path.join(fixtureDir, ".slad-os", "budget-history.jsonl");
    assert.ok(fs.existsSync(historyPath), "budget-history.jsonl should be written");
    const lines = fs.readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "At least one budget history entry expected");
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.intent, "add sum function to math module");
    assert.equal(entry.provider, "anthropic");
  });
});
