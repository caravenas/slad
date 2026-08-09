import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelProvider } from "@slad/model-providers";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import { autoCommand } from "../commands/auto.js";
import { getActiveSession, readSessionPlan } from "../core/session.js";
import { resetDocsRootCache } from "../persistence/layout.js";

const INTENT = "add sum function to math module";

const EXPLORE_FIXTURE = JSON.stringify({
  status: "completed",
  intent: INTENT,
  reframing: "Expose a typed sum utility.",
  approaches: [{ name: "Simple export", summary: "Export sum from math.ts", pros: [], cons: [] }],
  risks: [],
  openQuestions: [],
  recommendedNext: "Implement sum",
  questions: [],
});

const SNAPSHOT_FIXTURE = JSON.stringify({
  status: "completed",
  content: "# Snapshot\n\nAdd sum().",
  questions: [],
});

const PLAN_FIXTURE = JSON.stringify({
  status: "completed",
  snapshot: "Add sum().",
  summary: "One task.",
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
  ],
  verification: [],
  risks: [],
  openQuestions: [],
  recommendedFirstTask: "T1",
  questions: [],
});

function makeSequenceProvider(responses: string[]): ModelProvider {
  return {
    name: "cli" as ProviderName,
    supportsToolUse: false,
    async complete(_messages: ChatMessage[], _opts?: CompletionOptions): Promise<string> {
      const response = responses.shift();
      if (!response) throw new Error("No mock response left");
      return response;
    },
  };
}

async function withFixtureProject(fn: (fixtureDir: string) => Promise<void>): Promise<void> {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-auto-manifest-"));
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

function readOnlyManifest(fixtureDir: string): Record<string, unknown> {
  const runsDir = path.join(fixtureDir, ".slad-os", "runs");
  const manifestPaths = fs.readdirSync(runsDir)
    .map((runId) => path.join(runsDir, runId, "manifest.json"))
    .filter((filePath) => fs.existsSync(filePath));
  assert.equal(manifestPaths.length, 1);
  return JSON.parse(fs.readFileSync(manifestPaths[0]!, "utf8")) as Record<string, unknown>;
}

describe("E2E: slad auto manifest", { concurrency: 1 }, () => {
  it("binds generated plan metadata and non-executed tasks into the manifest", async () => {
    await withFixtureProject(async (fixtureDir) => {
      await autoCommand(INTENT, {
        provider: "cli",
        model: "mock",
        dryRun: true,
        fresh: true,
        skipLearn: true,
        classify: false,
        harness: "off",
        _provider: makeSequenceProvider([EXPLORE_FIXTURE, SNAPSHOT_FIXTURE, PLAN_FIXTURE]),
      });

      const session = getActiveSession();
      assert.ok(session);
      const plan = await readSessionPlan(session);
      assert.ok(plan);

      const manifest = readOnlyManifest(fixtureDir);
      assert.equal(manifest.intent, session.intent);
      assert.equal(manifest.status, "completed");
      assert.deepEqual(manifest.plan, {
        planId: plan.value.planId,
        hash: plan.value.approval.planHash,
        approval: "pending",
      });
      assert.deepEqual(manifest.tasks, [{ taskId: "T1", status: "skipped" }]);
    });
  });
});
