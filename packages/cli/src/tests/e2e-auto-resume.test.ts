import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelProvider } from "@slad/model-providers";
import type { ChatMessage, CompletionOptions, ProviderName, RunOutput } from "../core/types.js";
import { autoCommand } from "../commands/auto.js";
import { appendArtifact, createSession, getActiveSession, readSessionPlan, saveSession } from "../core/session.js";
import { resetDocsRootCache } from "../persistence/layout.js";
import { approvePlan, writeArtifact } from "../persistence/index.js";

const INTENT = "add sum function to math module";

const EXPLORE_FIXTURE = JSON.stringify({
  status: "completed",
  intent: INTENT,
  reframing: "Expose typed math helpers.",
  approaches: [{ name: "Simple export", summary: "Export helpers from math.ts", pros: [], cons: [] }],
  risks: [],
  openQuestions: [],
  recommendedNext: "Implement helpers",
  questions: [],
});

const SNAPSHOT_FIXTURE = JSON.stringify({
  status: "completed",
  content: "# Snapshot\n\nAdd math helpers.",
  questions: [],
});

const PLAN_FIXTURE = JSON.stringify({
  status: "completed",
  snapshot: "Add math helpers.",
  summary: "Two ordered tasks.",
  tasks: [
    {
      id: "T1",
      title: "Implement sum()",
      description: "Add sum(numbers: number[]): number",
      type: "implementation",
      priority: "high",
      dependsOn: [],
      files: ["src/math.ts"],
      acceptanceCriteria: ["sum returns totals"],
    },
    {
      id: "T2",
      title: "Implement mean()",
      description: "Add mean(numbers: number[]): number",
      type: "implementation",
      priority: "medium",
      dependsOn: ["T1"],
      files: ["src/math.ts"],
      acceptanceCriteria: ["mean returns averages"],
    },
  ],
  verification: [],
  risks: [],
  openQuestions: [],
  recommendedFirstTask: "T1",
  questions: [],
});

const RUN_T1: RunOutput = {
  taskId: "T1",
  status: "completed",
  summary: "sum implemented",
  changedFiles: ["src/math.ts"],
  verification: [],
  reviewerNotes: [],
  followUps: [],
  assumptions: [],
  decisions: [],
  questions: [],
  humanAnswers: {},
};

const RUN_T2 = JSON.stringify({
  taskId: "T2",
  status: "completed",
  summary: "mean implemented",
  changedFiles: ["src/math.ts"],
  verification: [],
  reviewerNotes: [],
  followUps: [],
  assumptions: [],
  decisions: [],
  questions: [],
  humanAnswers: {},
});

function makeSequenceProvider(responses: string[]): ModelProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "cli" as ProviderName,
    supportsToolUse: false,
    async complete(messages: ChatMessage[], _opts?: CompletionOptions): Promise<string> {
      calls.push(messages.map((message) => message.content).join("\n\n"));
      const response = responses.shift();
      if (!response) throw new Error(`No mock response left for call ${calls.length}`);
      return response;
    },
    calls,
  };
}

async function withFixtureProject(fn: (fixtureDir: string) => Promise<void>): Promise<void> {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-auto-resume-"));
  const originalCwd = process.cwd();
  const originalDocsPathEnv = process.env.SLAD_DOCS_PATH;
  const originalExitCode = process.exitCode;
  fs.writeFileSync(path.join(fixtureDir, "AGENTS.md"), "# Project\nA demo project.\n", "utf8");
  fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "src", "math.ts"), "export {};\n", "utf8");

  try {
    process.chdir(fixtureDir);
    process.env.SLAD_DOCS_PATH = path.join(fixtureDir, "docs");
    process.exitCode = undefined;
    resetDocsRootCache();
    await fn(fixtureDir);
  } finally {
    resetDocsRootCache();
    process.exitCode = originalExitCode;
    if (originalDocsPathEnv === undefined) delete process.env.SLAD_DOCS_PATH;
    else process.env.SLAD_DOCS_PATH = originalDocsPathEnv;
    process.chdir(originalCwd);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function readManifests(fixtureDir: string): Record<string, unknown>[] {
  const runsDir = path.join(fixtureDir, ".slad-os", "runs");
  return fs.readdirSync(runsDir)
    .map((runId) => path.join(runsDir, runId, "manifest.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
}

describe("E2E: slad auto resume", { concurrency: 1 }, () => {
  it("--fresh creates a new session instead of reusing the active one", async () => {
    await withFixtureProject(async () => {
      const first = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: first,
      });
      const firstSession = getActiveSession();
      assert.ok(firstSession);

      const second = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: second,
      });
      const secondSession = getActiveSession();
      assert.ok(secondSession);
      assert.notEqual(secondSession.id, firstSession.id);
    });
  });

  it("blocks intent mismatch against the active session", async () => {
    await withFixtureProject(async () => {
      const first = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: first,
      });

      const retry = makeSequenceProvider([]);
      await autoCommand("different intent", {
        provider: "cli",
        model: "mock",
        dryRun: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: retry,
      });

      assert.equal(retry.calls.length, 0);
      assert.equal(getActiveSession()?.intent, INTENT);
    });
  });

  it("--resume runs only the pending subset in the manifest", async () => {
    await withFixtureProject(async (fixtureDir) => {
      const planner = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: planner,
      });

      let session = getActiveSession();
      assert.ok(session);
      const planRef = session.artifacts.find((artifact) => artifact.kind === "plan");
      assert.ok(planRef);
      await approvePlan(planRef.path);
      const runRef = await writeArtifact("run", RUN_T1, { sessionId: session.id });
      session = appendArtifact(session, "run", runRef.path, "T1");
      saveSession(session);

      const runner = makeSequenceProvider([RUN_T2]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        resume: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: runner,
      });

      const plan = await readSessionPlan(getActiveSession()!);
      assert.equal(plan?.value.approval.status, "approved");

      const manifests = readManifests(fixtureDir);
      const resumeManifest = manifests.find((manifest) => {
        const tasks = manifest.tasks as { taskId: string; status: string }[];
        return tasks.length === 1 && tasks[0]?.taskId === "T2" && tasks[0]?.status === "completed";
      });
      assert.ok(resumeManifest, "resume manifest should track only T2");
      assert.equal((resumeManifest.plan as Record<string, unknown>).approval, "approved");
      assert.equal(resumeManifest.status, "completed");
    });
  });

  it("--resume without an active session exits 1 without touching provider or manifests", async () => {
    await withFixtureProject(async (fixtureDir) => {
      const runner = makeSequenceProvider([]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        resume: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: runner,
      });

      assert.equal(runner.calls.length, 0);
      assert.equal(process.exitCode, 1);
      assert.equal(fs.existsSync(path.join(fixtureDir, ".slad-os", "runs")), false);
    });
  });

  it("--resume with a session but no persisted plan exits 1 without touching provider or manifests", async () => {
    await withFixtureProject(async (fixtureDir) => {
      createSession(INTENT);

      const runner = makeSequenceProvider([]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        resume: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: runner,
      });

      assert.equal(runner.calls.length, 0);
      assert.equal(process.exitCode, 1);
      assert.equal(fs.existsSync(path.join(fixtureDir, ".slad-os", "runs")), false);
    });
  });

  it("--resume blocks when approved plan preflight fails", async () => {
    await withFixtureProject(async (fixtureDir) => {
      const planner = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: planner,
      });

      const session = getActiveSession();
      assert.ok(session);
      const planRef = session.artifacts.find((artifact) => artifact.kind === "plan");
      assert.ok(planRef);
      await approvePlan(planRef.path);

      const raw = JSON.parse(fs.readFileSync(planRef.path, "utf8")) as Record<string, unknown>;
      raw.input = { ...(raw.input as Record<string, unknown>), digest: "deadbeef" };
      fs.writeFileSync(planRef.path, JSON.stringify(raw, null, 2), "utf8");

      const runner = makeSequenceProvider([]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        resume: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: runner,
      });

      assert.equal(runner.calls.length, 0);
      assert.equal(process.exitCode, 1);
      assert.equal(readManifests(fixtureDir).length, 1, "preflight should block before creating a resume manifest");
    });
  });

  it("--resume blocks when the plan artifact belongs to another session id", async () => {
    await withFixtureProject(async (fixtureDir) => {
      const planner = makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: planner,
      });

      const session = getActiveSession();
      assert.ok(session);
      const planRef = session.artifacts.find((artifact) => artifact.kind === "plan");
      assert.ok(planRef);
      await approvePlan(planRef.path);

      const raw = JSON.parse(fs.readFileSync(planRef.path, "utf8")) as Record<string, unknown>;
      raw.sessionId = "other-session";
      fs.writeFileSync(planRef.path, JSON.stringify(raw, null, 2), "utf8");

      const runner = makeSequenceProvider([]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        resume: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: runner,
      });

      assert.equal(runner.calls.length, 0);
      assert.equal(process.exitCode, 1);
      assert.equal(readManifests(fixtureDir).length, 1, "session mismatch should block before creating a resume manifest");
    });
  });
});
