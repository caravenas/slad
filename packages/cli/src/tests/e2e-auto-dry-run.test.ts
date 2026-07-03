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
import { getActiveSession } from "../core/session.js";

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

const PLAN_TWO_TASKS_FIXTURE = JSON.stringify({
  status: "completed",
  snapshot: "Add sum() to math module.",
  summary: "Implement sum() in two dependent tasks.",
  tasks: [
    {
      id: "T1",
      title: "Create math module",
      description: "Add src/math.ts with a sum export.",
      type: "implementation",
      priority: "high",
      dependsOn: [],
      files: ["src/math.ts"],
      acceptanceCriteria: ["src/math.ts exists"],
    },
    {
      id: "T2",
      title: "Add sum behavior",
      description: "Implement sum(numbers: number[]): number.",
      type: "implementation",
      priority: "high",
      dependsOn: ["T1"],
      files: ["src/math.ts"],
      acceptanceCriteria: ["sum([1,2,3]) returns 6"],
    },
  ],
  verification: [],
  risks: [],
  openQuestions: [],
  recommendedFirstTask: "T1",
  questions: [],
});

const PLAN_BLOCKED_HITL_FIXTURE = JSON.stringify({
  status: "awaiting_human",
  snapshot: "Add sum() to math module.",
  summary: "Need a decision before planning.",
  tasks: [],
  verification: [],
  risks: [],
  openQuestions: [],
  questions: [
    {
      id: "target_file",
      prompt: "What file should be changed?",
      kind: "free",
      blocking: true,
    },
  ],
});

const EXPLORE_AWAITING_DEFAULT_FIXTURE = JSON.stringify({
  status: "awaiting_human",
  intent: "add sum function to math module",
  reframing: "Expose a typed sum() utility that handles arrays of numbers.",
  approaches: [
    {
      name: "Simple export",
      summary: "Export a single sum() function from math.ts",
      pros: ["minimal"],
      cons: ["limited scope"],
    },
  ],
  risks: [],
  openQuestions: [],
  recommendedNext: "Confirm the proposed scope.",
  questions: [
    {
      id: "confirm_scope",
      prompt: "Use the proposed scope?",
      kind: "confirm",
      default: "yes",
      blocking: true,
    },
  ],
});

function runFixture(taskId: string, status: "completed" | "failed", summary: string): string {
  return JSON.stringify({
    taskId,
    status,
    summary,
    changedFiles: status === "completed" ? ["src/math.ts"] : [],
    verification: [
      {
        command: "corepack pnpm test --filter math",
        status: status === "completed" ? "passed" : "failed",
        notes: summary,
      },
    ],
    reviewerNotes: status === "completed" ? ["ok"] : ["failed before completing task"],
    followUps: status === "completed" ? [] : ["retry task"],
    decisions: [],
    questions: [],
    humanAnswers: {},
  });
}

const RUN_T1_COMPLETED_FIXTURE = runFixture("T1", "completed", "T1 completed");
const RUN_T2_FAILED_FIXTURE = runFixture("T2", "failed", "T2 failed after T1 completed");
const RUN_T2_COMPLETED_FIXTURE = runFixture("T2", "completed", "T2 completed on retry");

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

function latestAutoReport(fixtureDir: string): Record<string, unknown> {
  const autoLogDir = path.join(fixtureDir, "docs", "log", "auto");
  const report = fs.readdirSync(autoLogDir).filter((f) => f.endsWith(".json")).sort().at(-1);
  assert.ok(report, "Expected at least one auto report");
  return readEnvelope(path.join(autoLogDir, report));
}

function artifactValues(session: NonNullable<ReturnType<typeof getActiveSession>>, kind: string): Record<string, unknown>[] {
  return session.artifacts
    .filter((artifact) => artifact.kind === kind)
    .map((artifact) => readEnvelope(artifact.path).value as Record<string, unknown>);
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
  it("starts a new session without a plan and persists explore, snapshot, and plan state", async () => {
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
        ["explore", "snapshot", "plan"],
      );
      assert.equal(artifactValues(session, "plan")[0]?.status, "completed");
      assert.equal(artifactValues(session, "snapshot")[0]?.status, "completed");
      assert.equal(provider.calls.length, 3, "new session should run explore, snapshot, and plan");
    });
  });

  it("resumes from an intermediate snapshot after an automatic HITL block and writes the missing plan", async () => {
    await withFixtureProject("slad-auto-intermediate-", async (fixtureDir) => {
      const firstProvider = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_BLOCKED_HITL_FIXTURE]);

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

      const blockedSession = getActiveSession();
      assert.ok(blockedSession, "blocked run should leave a persisted session");
      assert.deepEqual(
        blockedSession.artifacts.map((artifact) => artifact.kind),
        ["explore", "snapshot"],
      );

      const blockedReport = latestAutoReport(fixtureDir).value as Record<string, unknown>;
      const blockedMetadata = blockedReport.metadata as Record<string, unknown>;
      const blockedHitl = blockedMetadata.hitl as Record<string, unknown>[];
      assert.equal(blockedReport.status, "failed");
      assert.equal(blockedHitl[0]?.status, "blocked");
      assert.deepEqual(blockedHitl[0]?.unresolved, ["target_file"]);

      const retryProvider = makeSequenceProvider([PLAN_FIXTURE]);
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
        ["explore", "snapshot", "plan"],
      );
      assert.equal(artifactValues(resumedSession, "plan")[0]?.status, "completed");
      assert.equal(retryProvider.calls.length, 1, "retry should resume at plan instead of rerunning prior stages");
      assert.match(retryProvider.calls[0] ?? "", /Snapshot:/);
    });
  });

  it("does not restart completed work when retrying a partial plan", async () => {
    await withFixtureProject("slad-auto-partial-plan-", async () => {
      const firstProvider = makeSequenceProvider([
        EXPLORE_FIXTURE,
        SNAPSHOT_FIXTURE,
        PLAN_TWO_TASKS_FIXTURE,
        RUN_T1_COMPLETED_FIXTURE,
        RUN_T2_FAILED_FIXTURE,
      ]);

      await autoCommand("add sum function to math module", {
        provider: "cli",
        model: "claude-sonnet-4-6",
        skipLearn: true,
        fresh: true,
        classify: false,
        harness: "off",
        _provider: firstProvider,
      });

      const failedSession = getActiveSession();
      assert.ok(failedSession, "failed run should persist session state");
      const firstRunArtifacts = failedSession.artifacts.filter((artifact) => artifact.kind === "run");
      assert.deepEqual(firstRunArtifacts.map((artifact) => artifact.taskId), ["T1", "T2"]);
      assert.deepEqual(
        artifactValues(failedSession, "run").map((run) => [run.taskId, run.status]),
        [["T1", "completed"], ["T2", "failed"]],
      );

      const retryProvider = makeSequenceProvider([RUN_T2_COMPLETED_FIXTURE]);
      await autoCommand("add sum function to math module", {
        provider: "cli",
        model: "claude-sonnet-4-6",
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: retryProvider,
      });

      const resumedSession = getActiveSession();
      assert.ok(resumedSession, "retry should keep persisted state");
      const runValues = artifactValues(resumedSession, "run");
      assert.deepEqual(
        runValues.map((run) => [run.taskId, run.status]),
        [["T1", "completed"], ["T2", "failed"], ["T2", "completed"]],
      );
      assert.equal(retryProvider.calls.length, 1, "retry should execute exactly one pending task");
      assert.match(retryProvider.calls[0] ?? "", /"id": "T2"/);
      assert.doesNotMatch(retryProvider.calls[0] ?? "", /"id": "T1"/);
    });
  });

  it("auto-resolves HITL questions with defaults and persists a completed pipeline state", async () => {
    await withFixtureProject("slad-auto-hitl-default-", async (fixtureDir) => {
      const provider = makeSequenceProvider([
        EXPLORE_AWAITING_DEFAULT_FIXTURE,
        EXPLORE_FIXTURE,
        SNAPSHOT_FIXTURE,
        PLAN_FIXTURE,
      ]);

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
      assert.ok(session, "HITL default flow should persist a session");
      assert.deepEqual(
        session.artifacts.map((artifact) => artifact.kind),
        ["explore", "snapshot", "plan"],
      );
      assert.equal(artifactValues(session, "explore")[0]?.status, "completed");
      assert.match(provider.calls[1] ?? "", /confirm_scope/);
      assert.match(provider.calls[1] ?? "", /yes/);

      const report = latestAutoReport(fixtureDir).value as Record<string, unknown>;
      const metadata = report.metadata as Record<string, unknown>;
      const hitl = metadata.hitl as Record<string, unknown>[];
      assert.equal(report.status, "completed");
      assert.equal(hitl[0]?.status, "resolved");
      assert.deepEqual(hitl[0]?.answers, { confirm_scope: "yes" });
      assert.deepEqual(hitl[0]?.unresolved, []);
    });
  });
});
