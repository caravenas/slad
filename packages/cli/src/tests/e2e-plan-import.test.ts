/**
 * E2E test: slad plan --import with a canonical external plan (no LLM).
 *
 * Verifies the full flow import → check → approve → run: the backend provider
 * is never invoked before run, the imported plan is executed as-is (no
 * regeneration), and invalid documents never persist anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelProvider } from "@slad/model-providers";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import { autoCommand } from "../commands/auto.js";
import { planCommand } from "../commands/plan.js";
import { createSession, getActiveSession, readSessionPlan } from "../core/session.js";
import { resetDocsRootCache } from "../persistence/layout.js";

const INTENT = "add sum function to math module";

const EXTERNAL_PLAN = {
  kind: "slad.external-plan",
  schemaVersion: 1,
  intent: INTENT,
  snapshot: {
    status: "completed",
    content: "# Snapshot\n\nAdd sum() to the math module.",
  },
  plan: {
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
        acceptanceCriteria: ["sum([1,2,3]) returns 6"],
      },
    ],
    recommendedFirstTask: "T1",
  },
  source: { producer: "external-planner", createdAt: "2026-08-09T10:00:00.000Z" },
};

const RUN_T1 = JSON.stringify({
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
  const fixtureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slad-e2e-plan-import-")));
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

function writeExternalPlan(fixtureDir: string, document: unknown = EXTERNAL_PLAN): string {
  const filePath = path.join(fixtureDir, "external-plan.json");
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), "utf8");
  return filePath;
}

describe("E2E: slad plan --import (no LLM)", { concurrency: 1 }, () => {
  it("imports, checks, approves and runs without invoking the backend before run", async () => {
    await withFixtureProject(async (fixtureDir) => {
      createSession(INTENT);
      const filePath = writeExternalPlan(fixtureDir);

      // Import: persists a pending plan without any provider involved.
      await planCommand({ import: filePath });
      assert.equal(process.exitCode, undefined);

      let session = getActiveSession();
      assert.ok(session);
      assert.deepEqual(session.artifacts.map((artifact) => artifact.kind), ["plan"]);
      let plan = await readSessionPlan(session);
      assert.equal(plan?.value.approval.status, "pending");
      assert.equal(plan?.value.plan.tasks[0]?.title, "Implement sum()");

      // No generation artifacts: import must not run explore/snapshot/plan stages.
      const logDir = path.join(fixtureDir, "docs", "log");
      assert.equal(fs.existsSync(path.join(logDir, "explores")), false);
      assert.equal(fs.existsSync(path.join(logDir, "snapshots")), false);

      // Check: read-only preflight passes.
      await planCommand({ check: true });
      assert.equal(process.exitCode, undefined);

      // Approve: the imported plan becomes executable.
      await planCommand({ approve: true });
      assert.equal(process.exitCode, undefined);
      session = getActiveSession();
      assert.ok(session);
      plan = await readSessionPlan(session);
      assert.equal(plan?.value.approval.status, "approved");

      // Run: only now is the backend invoked, executing the imported plan as-is.
      const runner = makeSequenceProvider([RUN_T1]);
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        resume: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: runner,
      });

      assert.equal(process.exitCode, undefined);
      assert.equal(runner.calls.length, 1, "backend must be invoked exactly once, at run");
      assert.ok(runner.calls[0]!.includes("Implement sum()"), "run must execute the imported task");

      session = getActiveSession();
      assert.ok(session);
      assert.deepEqual(session.artifacts.map((artifact) => artifact.kind), ["plan", "run"]);
      plan = await readSessionPlan(session);
      assert.equal(plan?.value.approval.status, "approved", "run must not regenerate the plan");
    });
  });

  it("rejects an invalid document and leaves the session without a plan", async () => {
    await withFixtureProject(async (fixtureDir) => {
      createSession(INTENT);
      const filePath = writeExternalPlan(fixtureDir, { ...EXTERNAL_PLAN, schemaVersion: 2 });

      await planCommand({ import: filePath });

      assert.equal(process.exitCode, 1);
      assert.equal(fs.existsSync(path.join(fixtureDir, "docs", "log", "plans")), false);
      const session = getActiveSession();
      assert.ok(session);
      assert.deepEqual(session.artifacts, []);
    });
  });

  it("rejects an intent mismatch and a preflight-invalid plan without persisting", async () => {
    await withFixtureProject(async (fixtureDir) => {
      createSession(INTENT);

      await planCommand({ import: writeExternalPlan(fixtureDir, { ...EXTERNAL_PLAN, intent: "another goal" }) });
      assert.equal(process.exitCode, 1);

      process.exitCode = undefined;
      const badPlan = {
        ...EXTERNAL_PLAN,
        plan: {
          ...EXTERNAL_PLAN.plan,
          tasks: [
            { ...EXTERNAL_PLAN.plan.tasks[0]! },
            { ...EXTERNAL_PLAN.plan.tasks[0]! },
          ],
        },
      };
      await planCommand({ import: writeExternalPlan(fixtureDir, badPlan) });
      assert.equal(process.exitCode, 1);

      assert.equal(fs.existsSync(path.join(fixtureDir, "docs", "log", "plans")), false);
      assert.deepEqual(getActiveSession()?.artifacts, []);
    });
  });
});
