import assert from "node:assert/strict";
import test from "node:test";
import type { Question } from "@slad/shared";
import { createHitlTransport, formatAnswersForPrompt, HTTPTransport } from "./index.js";

test("http transport exposes HITL protocol without TTY dependencies", async () => {
  const pending: Question[] = [{ id: "goal", kind: "free", prompt: "Goal?", blocking: true }];
  const transport = createHitlTransport("http", { wsUrl: "ws://localhost:3001" });

  await assert.rejects(
    () => transport.collectAnswers(pending),
    /HTTPTransport is a stub/,
  );
  assert.equal(transport.canInteract(), false);
  assert.ok(transport instanceof HTTPTransport);
});

test("formatAnswersForPrompt serializes answers for the next LLM turn", () => {
  assert.equal(
    formatAnswersForPrompt({ goal: "Ship UI", risk: "Low" }),
    "Respuestas del humano:\n- goal: Ship UI\n- risk: Low\n\nContinuá la tarea con esta información. Respondé ÚNICAMENTE con el JSON de output según el schema esperado, sin texto adicional.",
  );
});
