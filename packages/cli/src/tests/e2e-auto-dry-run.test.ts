/**
 * E2E test: slad auto --dry-run against a fixture project using a mock provider.
 *
 * Verifies that autonomous planning produces one pending plan artifact and an
 * auto report, without persisting intermediate explore/snapshot artifacts.
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
import { getActiveSession, readSessionPlan } from "../core/session.js";

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
    name: "cli" as ProviderName,
    supportsToolUse: false,
    async complete(_messages: ChatMessage[], _opts?: CompletionOptions): Promise<string> {
      const response = responses[callCount % responses.length] ?? PLAN_FIXTURE;
      callCount++;
      return response;
    },
  };
}

function makeSequenceProvider(responses: string[]): ModelProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "cli" as ProviderName,
    supportsToolUse: false,
    async complete(messages: ChatMessage[], _opts?: CompletionOptions): Promise<string> {
      calls.push(messages.map((message) => message.content).join("\n\n"));
      const response = responses.shift();
      if (!response) {
        throw new Error(`No mock response left for call ${calls.length}`);
      }
      return response;
    },
    calls,
  };
}

async function withFixtureProject(
  prefix: string,
  fn: (fixtureDir: string) => Promise<void>,
): Promise<void> {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const originalCwd = process.cwd();
  const originalDocsPathEnv = process.env.SLAD_DOCS_PATH;
  fs.writeFileSync(path.join(fixtureDir, "AGENTS.md"), "# Project\nA demo project.\n", "utf8");
  fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "src", "math.ts"), "export {};\n", "utf8");

  try {
    process.chdir(fixtureDir);
    process.env.SLAD_DOCS_PATH = path.join(fixtureDir, "docs");
    resetDocsRootCache();
    await fn(fixtureDir);
  } finally {
    resetDocsRootCache();
    if (originalDocsPathEnv === undefined) delete process.env.SLAD_DOCS_PATH;
    else process.env.SLAD_DOCS_PATH = originalDocsPathEnv;
    process.chdir(originalCwd);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function readEnvelope(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
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

  it("writes only the pending plan artifact during pre-run planning", async () => {
    const mockProvider = makeMockProvider();

    await autoCommand("add sum function to math module", {
      provider: "cli",
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

    assert.ok(fs.existsSync(path.join(logDir, "plans")), "plans dir should exist");

    const plans = fs.readdirSync(path.join(logDir, "plans")).filter((f) => f.endsWith(".json"));

    assert.ok(plans.length >= 1, `Expected ≥1 plan artifact, got ${plans.length}`);
    assert.equal(fs.existsSync(path.join(logDir, "explores")), false);
    assert.equal(fs.existsSync(path.join(logDir, "snapshots")), false);

    const plan = readEnvelope(path.join(logDir, "plans", plans[0]!));
    assert.equal(plan.kind, "plan");
    assert.equal((plan.approval as Record<string, unknown>).status, "pending");
  });

  it("writes an auto-report under docs/log/auto/", async () => {
    const mockProvider = makeMockProvider();

    await autoCommand("add sum function to math module", {
      provider: "cli",
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
      provider: "cli",
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
      provider: "cli",
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
    assert.equal(entry.provider, "cli");
  });
});

describe("E2E: slad auto resume coverage", { concurrency: 1 }, () => {
  it("starts a new session and persists only a pending plan", async () => {
    await withFixtureProject("slad-auto-new-session-", async () => {
      const provider = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);

      await autoCommand("add sum function to math module", {
        provider: "cli",
        model: "claude-sonnet-4-6",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: provider,
      });

      const session = getActiveSession();
      assert.ok(session, "auto should create and persist an active session");
      assert.deepEqual(
        session.artifacts.map((artifact) => artifact.kind),
        ["plan"],
      );
      const plan = await readSessionPlan(session);
      assert.equal(plan?.value.approval.status, "pending");
      assert.equal(plan?.value.plan.status, "completed");
      assert.equal(provider.calls.length, 3, "new session should run explore, snapshot, and plan");
    });
  });

  it("does not regenerate or execute a pending plan before approval", async () => {
    await withFixtureProject("slad-auto-pending-plan-", async () => {
      const firstProvider = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);

      await autoCommand("add sum function to math module", {
        provider: "cli",
        model: "claude-sonnet-4-6",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: firstProvider,
      });

      const pendingSession = getActiveSession();
      assert.ok(pendingSession, "planning should leave a persisted session");
      assert.deepEqual(
        pendingSession.artifacts.map((artifact) => artifact.kind),
        ["plan"],
      );

      const retryProvider = makeSequenceProvider([]);
      await autoCommand("add sum function to math module", {
        provider: "cli",
        model: "claude-sonnet-4-6",
        dryRun: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: retryProvider,
      });

      const resumedSession = getActiveSession();
      assert.ok(resumedSession, "retry should keep the active session");
      assert.deepEqual(
        resumedSession.artifacts.map((artifact) => artifact.kind),
        ["plan"],
      );
      assert.equal(retryProvider.calls.length, 0, "pending plan must not be regenerated");
    });
  });

});
