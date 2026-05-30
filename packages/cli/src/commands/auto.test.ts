import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  completeAutoPipelineStage,
  completedAutoStagesThrough,
  createAutoPipelineProgress,
  createAutoPipelineReport,
  filesystemSafeTimestamp,
  getAutoPipelineStatus,
  stageArtifactDirName,
} from "@slad/pipeline";

/**
 * Tests para el comando auto.
 *
 * Nota: `autoCommand` requiere providers reales y sistema de archivos.
 * Estos tests verifican la lógica de helpers y PipelineStop sin hacer API calls.
 */

describe("auto helpers", () => {
  it("stageArtifactDirName mapea stages correctamente", () => {
    assert.equal(stageArtifactDirName("explore"),  "explores");
    assert.equal(stageArtifactDirName("snapshot"), "snapshots");
    assert.equal(stageArtifactDirName("plan"),     "plans");
    assert.equal(stageArtifactDirName("run"),      "runs");
    assert.equal(stageArtifactDirName("learn"),    "learnings");
    assert.equal(stageArtifactDirName("unknown"),  "unknown");
  });

  it("completedAutoStagesThrough resume stages correctamente", () => {
    assert.deepEqual(completedAutoStagesThrough("explore"), ["explore"]);
    assert.deepEqual(completedAutoStagesThrough("snapshot"), ["explore", "snapshot"]);
    assert.deepEqual(completedAutoStagesThrough("plan"), ["explore", "snapshot", "plan"]);
    assert.deepEqual(completedAutoStagesThrough("run"), ["explore", "snapshot", "plan", "run"]);
    assert.deepEqual(completedAutoStagesThrough("learn"), ["explore", "snapshot", "plan", "run", "learn"]);
  });

  it("filesystemSafeTimestamp genera string sin caracteres inválidos en rutas", () => {
    const result = filesystemSafeTimestamp("2026-05-25T12:34:56.789Z");
    assert.equal(result, "2026-05-25T12-34-56-789Z");
    assert.ok(!result.includes(":"), "No debe contener ':'");
    assert.ok(!result.includes("."), "No debe contener '.'");
  });

  it("createAutoPipelineProgress y completeAutoPipelineStage centralizan progreso", () => {
    const initial = createAutoPipelineProgress();
    const afterExplore = completeAutoPipelineStage({
      intent: "extraer pipeline sdk",
      sessionId: "session_123",
      stage: "explore",
      artifactPath: "/tmp/explore.json",
      budgetState: { inputTokens: 10 },
      progress: initial,
    });

    assert.deepEqual(afterExplore.stagesCompleted, ["explore"]);
    assert.deepEqual(afterExplore.artifacts, { explore: "/tmp/explore.json" });

    const resumed = createAutoPipelineProgress(afterExplore.checkpoint);
    assert.deepEqual(resumed.stagesCompleted, ["explore"]);
    assert.deepEqual(resumed.artifacts, { explore: "/tmp/explore.json" });
  });
});

// ─── PipelineStop (clase interna — testeada via comportamiento) ───────────────

describe("pipeline stop behavior", () => {
  it("dry-run con stages completos reporta 'completed'", () => {
    const status = getAutoPipelineStatus({
      dryRun: true,
      stagesCompleted: ["explore", "snapshot", "plan"],
      stoppedAt: "plan",
      stopReason: "Dry run — solo explore+snapshot+plan",
    });

    assert.equal(status, "completed");
  });

  it("pipeline parcial con algunos stages completos reporta 'partial'", () => {
    const status = getAutoPipelineStatus({
      stagesCompleted: ["explore", "snapshot"],
    });

    assert.equal(status, "partial");
  });

  it("pipeline sin stages completos reporta 'failed'", () => {
    const status = getAutoPipelineStatus({ stagesCompleted: [] });

    assert.equal(status, "failed");
  });

  it("createAutoPipelineReport omite stoppedAt/stopReason en dry-run exitoso", () => {
    const report = createAutoPipelineReport({
      intent: "extraer pipeline sdk",
      startedAt: "2026-05-25T00:00:00.000Z",
      completedAt: "2026-05-25T00:05:00.000Z",
      durationMs: 300000,
      dryRun: true,
      stagesCompleted: ["explore", "snapshot", "plan"],
      stoppedAt: "plan",
      stopReason: "Dry run — solo explore+snapshot+plan",
      artifacts: { plan: "/tmp/plan.json" },
      budget: { inputTokens: 10, outputTokens: 20 },
    });

    assert.equal(report.status, "completed");
    assert.equal(report.stoppedAt, undefined);
    assert.equal(report.stopReason, undefined);
  });
});

// ─── onUsage callback integration ─────────────────────────────────────────────

describe("onUsage callback (BudgetTracker integration)", () => {
  it("record acumula tokens al llamar onUsage", async () => {
    // Dinámica: importar BudgetTracker directamente para verificar la integración
    const { BudgetTracker } = await import("@slad/context-budget");
    const budget = new BudgetTracker("gpt-4o");

    // Simular cómo auto.ts crea el callback
    const makeUsageCb = (stage: string) => (input: number, output: number) => {
      budget.record(stage, input, output);
    };

    const cb = makeUsageCb("explore");
    cb(1000, 500);
    cb(2000, 800);

    const state = budget.getState();
    assert.equal(state.inputTokens, 3000);
    assert.equal(state.outputTokens, 1300);
    assert.equal(state.byStage["explore"]?.calls, 2);
  });
});
