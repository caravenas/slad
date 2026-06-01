import { z } from "zod";
import { PlanOutput, RunOutput, type ChatMessage } from "@slad/shared";
import { defineStage } from "../stage.js";
import type { SladServices } from "./types.js";

const DEFAULT_BUILDER_REVIEWER = "You are a builder-reviewer agent. Execute the task and output JSON only.";

export type RunStageResult = RunOutput[];

export const runStage = defineStage<PlanOutput, RunStageResult, SladServices>({
  id: "run",
  description: "Ejecuta las tareas del plan en orden topológico",
  inputSchema: PlanOutput as z.ZodType<PlanOutput>,
  outputSchema: z.array(RunOutput) as z.ZodType<RunStageResult>,
  permissions: ["read", "write", "shell", "network"],
  cache: { enabled: false },

  async run(input, ctx) {
    const { prompts, promptGuidance, hitl, harness, workspace, onTaskStart, onTaskComplete } = ctx.services;
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
          `Selected task:\n${JSON.stringify(t, null, 2)}`,
        ].filter(Boolean).join("\n\n");

        const messages: ChatMessage[] = [{ role: "user", content: runUserContent }];
        let output!: RunOutput;
        const maxRounds = 3;
        let rounds = 0;

        while (rounds <= maxRounds) {
          try {
            output = await ctx.model.generateObject({
              schema: RunOutput as z.ZodType<RunOutput>,
              system,
              messages,
              temperature: 0.2,
              maxTokens: 3000,
            });
          } catch (err) {
            output = {
              taskId: t.id,
              status: "failed",
              summary: `Failed to generate RunOutput: ${(err as Error).message}`,
              changedFiles: [],
              decisions: [],
              questions: [],
              humanAnswers: {},
              followUps: [],
              verification: [],
              reviewerNotes: [],
            };
            break;
          }

          if (output.status !== "awaiting_human" || output.questions.length === 0 || !hitl) {
            break;
          }

          if (rounds >= maxRounds || !hitl.canPrompt()) {
            break;
          }

          const answers = await hitl.collectAnswers(output.questions);
          const lines = Object.entries(answers).map(([id, value]) => `- ${id}: ${value}`);
          messages.push({ role: "assistant", content: JSON.stringify(output) });
          messages.push({ role: "user", content: `Respuestas del humano:\n${lines.join("\n")}\n\nContinuá la tarea. Respondé ÚNICAMENTE con el JSON.` });
          rounds++;
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
