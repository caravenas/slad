import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HTTPTransport, TTYTransport, createHitlTransport, formatAnswersForPrompt } from "./index.js";
import type { Question } from "@slad/shared";

describe("@slad/hitl transport boundary", () => {
  test("createHitlTransport returns a non-interactive HTTP transport stub", async () => {
    const transport = createHitlTransport("http", { wsUrl: "ws://localhost:3001" });
    assert.equal(transport.kind, "http");
    assert.equal(transport.canInteract(), false);
    await assert.rejects(
      () => transport.collectAnswers([{ id: "q1", prompt: "Proceed?", kind: "confirm", blocking: true }]),
      /not implemented/i,
    );
  });

  test("TTYTransport delegates question collection through injected handlers", async () => {
    const asked: Question[] = [];
    const transport = new TTYTransport({
      isTTY: () => true,
      askQuestion: async (q) => {
        asked.push(q);
        return `answer:${q.id}`;
      },
      writeLine: () => {},
    });
    const answers = await transport.collectAnswers([
      { id: "first", prompt: "First?", kind: "free", blocking: true },
      { id: "second", prompt: "Second?", kind: "choice", choices: ["a", "b"], blocking: true },
    ]);
    assert.deepEqual(answers, { first: "answer:first", second: "answer:second" });
    assert.equal(asked.length, 2);
  });

  test("formatAnswersForPrompt preserves existing HITL prompt contract", () => {
    assert.match(formatAnswersForPrompt({ q1: "yes" }), /- q1: yes/);
    assert.match(formatAnswersForPrompt({ q1: "yes" }), /Respondé ÚNICAMENTE/);
  });

  test("createHitlTransport returns TTYTransport by default", () => {
    assert.ok(createHitlTransport("tty") instanceof TTYTransport);
  });

  test("HTTPTransport stores endpoint configuration for future UI websocket integration", () => {
    const transport = new HTTPTransport({ wsUrl: "ws://localhost:3001/hitl", timeoutMs: 1000 });
    assert.equal(transport.wsUrl, "ws://localhost:3001/hitl");
    assert.equal(transport.timeoutMs, 1000);
  });
});
