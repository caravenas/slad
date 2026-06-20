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
import {
  AutoHitlBlockedError,
  completedRunTaskIds,
  formatAutoHitlBlockedMessage,
  isCompleteAutoStageOutput,
  planPendingRunTasks,
  resolveAutoHitlQuestions,
} from "./auto.js";
import type { PlanOutput, Question, RunOutput } from "../core/types.js";

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

  it("isCompleteAutoStageOutput valida completitud verificable por stage", () => {
    assert.equal(isCompleteAutoStageOutput("snapshot", { status: "completed" }), true);
    assert.equal(isCompleteAutoStageOutput("snapshot", { status: "awaiting_human" }), false);
    assert.equal(isCompleteAutoStageOutput("run", [{ taskId: "T1", status: "completed" }]), true);
    assert.equal(
      isCompleteAutoStageOutput("run", [
        { taskId: "T1", status: "completed" },
        { taskId: "T2", status: "failed" },
      ]),
      false,
    );
  });

  it("planPendingRunTasks conserva solo tareas pendientes y dependencias pendientes", () => {
    const plan: PlanOutput = {
      status: "completed",
      snapshot: "test",
      summary: "Plan de prueba",
      tasks: [
        {
          id: "T1",
          title: "Base",
          description: "Completar base",
          type: "implementation",
          priority: "high",
          dependsOn: [],
          files: ["src/base.ts"],
          acceptanceCriteria: ["T1 completa"],
        },
        {
          id: "T2",
          title: "Feature",
          description: "Completar feature",
          type: "implementation",
          priority: "high",
          dependsOn: ["T1"],
          files: ["src/feature.ts"],
          acceptanceCriteria: ["T2 completa"],
        },
        {
          id: "T3",
          title: "Review",
          description: "Revisar feature",
          type: "review",
          priority: "medium",
          dependsOn: ["T2"],
          files: ["src/feature.ts"],
          acceptanceCriteria: ["Review completa"],
        },
      ],
      verification: [],
      risks: [],
      openQuestions: [],
      recommendedFirstTask: "T1",
      questions: [],
      decisions: [],
    };
    const runs: RunOutput[] = [
      {
        taskId: "T1",
        status: "completed",
        summary: "T1 ok",
        changedFiles: ["src/base.ts"],
        verification: [],
        reviewerNotes: [],
        followUps: [],
        decisions: [],
        questions: [],
        humanAnswers: {},
      },
      {
        taskId: "T2",
        status: "failed",
        summary: "T2 falla",
        changedFiles: [],
        verification: [],
        reviewerNotes: [],
        followUps: [],
        decisions: [],
        questions: [],
        humanAnswers: {},
      },
    ];

    assert.deepEqual([...completedRunTaskIds(plan, runs)], ["T1"]);
    const pending = planPendingRunTasks(plan, runs);

    assert.deepEqual(pending.tasks.map((task) => task.id), ["T2", "T3"]);
    assert.deepEqual(pending.tasks[0]?.dependsOn, []);
    assert.deepEqual(pending.tasks[1]?.dependsOn, ["T2"]);
    assert.equal(pending.recommendedFirstTask, "T2");
  });

  it("resolveAutoHitlQuestions aplica defaults seguros sin intervención humana", () => {
    const questions: Question[] = [
      {
        id: "confirm_scope",
        prompt: "¿Usar scope propuesto?",
        kind: "confirm",
        default: "yes",
        blocking: true,
      },
      {
        id: "single_choice",
        prompt: "Elegí provider",
        kind: "choice",
        choices: ["local"],
        blocking: true,
      },
      {
        id: "optional_note",
        prompt: "Nota opcional",
        kind: "free",
        default: "sin nota",
        blocking: false,
      },
    ];

    const resolution = resolveAutoHitlQuestions("snapshot", questions);

    assert.deepEqual(resolution.answers, {
      confirm_scope: "yes",
      single_choice: "local",
      optional_note: "sin nota",
    });
    assert.deepEqual(resolution.unresolved, []);
  });

  it("resolveAutoHitlQuestions usa la regla de explore para elegir el primer approach", () => {
    const questions: Question[] = [
      {
        id: "approach",
        prompt: "¿Qué enfoque usar?",
        kind: "choice",
        choices: ["adaptar actual", "reescribir"],
        blocking: true,
      },
    ];

    const resolution = resolveAutoHitlQuestions("explore", questions);

    assert.deepEqual(resolution.answers, { approach: "adaptar actual" });
    assert.deepEqual(resolution.unresolved, []);
  });

  it("resolveAutoHitlQuestions deja unresolved cuando no hay política segura", () => {
    const questions: Question[] = [
      {
        id: "target_file",
        prompt: "¿Qué archivo edito?",
        kind: "free",
        blocking: true,
      },
    ];

    const resolution = resolveAutoHitlQuestions("run", questions);

    assert.deepEqual(resolution.answers, {});
    assert.deepEqual(resolution.unresolved.map((q) => q.id), ["target_file"]);
    assert.match(formatAutoHitlBlockedMessage("run", resolution.unresolved), /agregá un default seguro/i);
    assert.match(new AutoHitlBlockedError("run", resolution.unresolved).message, /HITL automático bloqueado/);
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
