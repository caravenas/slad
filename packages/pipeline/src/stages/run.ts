import { z } from "zod";
import { PlanOutput, RunOutput, toCompactJson, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import { isBlockingQuestion, mergeUnansweredQuestions } from "./util.js";
import type { SladServices } from "./types.js";

const DEFAULT_BUILDER_REVIEWER = "You are a builder-reviewer agent. Execute the task and output JSON only.";

export type RunStageResult = RunOutput[];

/**
 * El run stage corre sin humano: "awaiting_human" no es un estado alcanzable.
 * Una pregunta no bloqueante no impide cerrar la tarea; una bloqueante significa que
 * el worker no hizo el trabajo, así que se reporta como "blocked" con las preguntas
 * convertidas en followUps.
 */
function normalizeAwaitingHuman(output: RunOutput): RunOutput {
  if (output.status !== "awaiting_human") return output;

  const blocking = output.questions.filter(isBlockingQuestion);
  if (blocking.length === 0) {
    return { ...output, status: "completed", questions: [] };
  }

  return {
    ...output,
    status: "blocked",
    summary: `Bloqueado sin decisión autónoma: ${output.summary}`,
    followUps: mergeUnansweredQuestions(output.followUps, blocking),
    questions: [],
  };
}

export const runStage = defineStage<PlanOutput, RunStageResult, SladServices>({
  id: "run",
  description: "Ejecuta las tareas del plan en orden topológico",
  inputSchema: PlanOutput as z.ZodType<PlanOutput>,
  outputSchema: z.array(RunOutput) as z.ZodType<RunStageResult>,
  permissions: ["workspace:read", "workspace:write", "model:generate"],
  cache: { enabled: false },

  async run(input, ctx) {
    const { prompts, promptGuidance, harness, workspace, maxTasks, onTaskStart, onTaskComplete } = ctx.services;
    const baseSystem = prompts?.builderReviewer ?? DEFAULT_BUILDER_REVIEWER;
    const system = promptGuidance ? promptGuidance("run", baseSystem) : baseSystem;

    const state = new Map<string, "pending" | "done" | "failed" | "skipped">();
    for (const t of input.tasks) state.set(t.id, "pending");

    const results: RunOutput[] = [];
    let pending = true;

    while (pending) {
      pending = false;

      for (const t of input.tasks) {
        if (state.get(t.id) !== "pending") continue;
        if (maxTasks !== undefined && results.length >= maxTasks) {
          for (const [taskId, status] of state) {
            if (status === "pending") state.set(taskId, "skipped");
          }
          pending = false;
          break;
        }

        const deps = t.dependsOn.map(d => state.get(d) ?? "pending");
        if (deps.some(d => d === "failed" || d === "skipped")) {
          state.set(t.id, "skipped");
          continue;
        }
        if (deps.some(d => d === "pending")) {
          pending = true;
          continue;
        }

        if (harness) {
          const verdict = await harness.beforeTask(t, null);
          if (verdict.action === "deny") {
            state.set(t.id, "failed");
            results.push({
              taskId: t.id,
              status: "failed",
              summary: `Task denied by harness: ${verdict.reason}`,
              changedFiles: [],
              decisions: [],
              assumptions: [],
              questions: [],
              humanAnswers: {},
              followUps: [],
              verification: [],
              reviewerNotes: [],
            });
            pending = true;
            break;
          }
        }

        onTaskStart?.(t.id, t.title);

        const runUserContent = [
          workspace ? `Workspace context:\n${workspace}` : "",
          `Plan summary:\n${input.summary}`,
          `Selected task:\n${toCompactJson(t)}`,
        ].filter(Boolean).join("\n\n");

        const messages: ChatMessage[] = [{ role: "user", content: runUserContent }];
        let output: RunOutput;

        try {
          output = normalizeAwaitingHuman(await ctx.model.generateObject({
            schema: RunOutput as z.ZodType<RunOutput>,
            system,
            messages,
            temperature: 0.2,
            maxTokens: 3000,
          }));
        } catch (err) {
          output = {
            taskId: t.id,
            status: "failed",
            summary: `Failed to generate RunOutput: ${(err as Error).message}`,
            changedFiles: [],
            decisions: [],
            assumptions: [],
            questions: [],
            humanAnswers: {},
            followUps: [],
            verification: [],
            reviewerNotes: [],
          };
        }

        if (harness) {
          await harness.afterTask(t, output, 0); // FASE 4: mock durationMs for now
        }

        state.set(t.id, output.status === "completed" ? "done" : "failed");
        onTaskComplete?.(t.id, output.status);
        results.push(output);

        pending = true;
        break;
      }
    }

    await ctx.emitArtifact("run", results);
    return results;
  },
});
