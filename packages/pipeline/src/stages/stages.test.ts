import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateObjectOptions, ModelAdapter, ModelProvider } from "@slad/model-providers";
import type { ToolRegistry } from "@slad/tools";
import type { HITLTransport } from "@slad/hitl";
import type { PlanOutput } from "@slad/shared";
import { exploreStage } from "./explore.js";
import { snapshotStage } from "./snapshot.js";
import { planStage } from "./plan.js";
import { runStage } from "./run.js";
import type { SladServices } from "./types.js";
import type { StageContext } from "../types.js";

/** HITL transport que falla el test si un stage intenta usarlo. */
function forbiddenHitl(): HITLTransport {
  const fail = (): never => assert.fail("los stages no deben usar HITL");
  return {
    kind: "tty",
    canPrompt: () => true,
    canInteract: () => true,
    askQuestion: fail,
    collectAnswers: fail,
  } as unknown as HITLTransport;
}

interface StageHarness {
  ctx: StageContext<SladServices>;
  modelCalls: () => number;
  artifacts: () => Array<{ name: string; value: unknown }>;
}

/** ctx mínimo: el modelo devuelve `responses` en orden, parseado por el schema del stage. */
function makeHarness(responses: unknown[]): StageHarness {
  const artifacts: Array<{ name: string; value: unknown }> = [];
  let calls = 0;

  const model: ModelAdapter = {
    provider: { name: "cli", complete: async () => "" } as unknown as ModelProvider,
    generateText: async () => "",
    generateObject: async <T>(opts: GenerateObjectOptions<T>): Promise<T> => {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return opts.schema.parse(response);
    },
  };

  const services: SladServices = {
    provider: model.provider,
    hitl: forbiddenHitl(),
  };

  const ctx: StageContext<SladServices> = {
    pipelineId: "test",
    runId: "test-run",
    stageId: "test-stage",
    services,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    state: new Map(),
    model,
    tools: {} as ToolRegistry, // los stages de SLAD no leen el registry
    audit: { emit() {} },
    async emitArtifact(name, value) {
      artifacts.push({ name, value });
      return { stageId: "test-stage", name, value, createdAt: new Date().toISOString() };
    },
  };

  return { ctx, modelCalls: () => calls, artifacts: () => artifacts };
}

const EXPLORE_AWAITING = {
  status: "awaiting_human",
  reframing: "reformulado",
  approaches: [{ name: "A", summary: "una opción", pros: [], cons: [] }],
  risks: [],
  openQuestions: ["¿alcance del cambio?"],
  recommendedNext: "snapshot",
  questions: [{ id: "scope", prompt: "¿Incluimos el CLI?", kind: "confirm", default: "no" }],
};

const PLAN_INPUT: PlanOutput = {
  status: "completed",
  snapshot: "snap",
  summary: "resumen",
  tasks: [{
    id: "T1",
    title: "tarea",
    description: "hacer algo",
    type: "implementation",
    priority: "high",
    dependsOn: [],
    files: [],
    acceptanceCriteria: ["compila"],
  }],
  verification: [],
  risks: [],
  openQuestions: [],
  questions: [],
  decisions: [],
};

test("explore hace una sola llamada y no consulta al humano ante awaiting_human", async () => {
  const harness = makeHarness([EXPLORE_AWAITING]);

  const output = await exploreStage.run({ intent: "mejorar el pipeline" }, harness.ctx);

  assert.equal(harness.modelCalls(), 1);
  assert.equal(output.status, "completed");
  assert.deepEqual(output.questions, []);
  assert.equal(output.intent, "mejorar el pipeline");
  assert.deepEqual(output.openQuestions, [
    "¿alcance del cambio?",
    "Sin respuesta humana — ¿Incluimos el CLI? (asumido: no)",
  ]);
  assert.equal(harness.artifacts()[0]?.name, "explore");
});

test("snapshot registra las preguntas del modelo como assumptions y completa", async () => {
  const harness = makeHarness([{
    status: "awaiting_human",
    content: "# Snapshot",
    assumptions: ["se asume Node 22"],
    questions: [{ id: "db", prompt: "¿Postgres o SQLite?", kind: "choice", choices: ["postgres", "sqlite"] }],
  }]);

  const output = await snapshotStage.run(
    { ...EXPLORE_AWAITING, status: "completed", intent: "x", questions: [], decisions: [] } as never,
    harness.ctx,
  );

  assert.equal(harness.modelCalls(), 1);
  assert.equal(output.status, "completed");
  assert.deepEqual(output.questions, []);
  assert.deepEqual(output.assumptions, [
    "se asume Node 22",
    "Sin respuesta humana — ¿Postgres o SQLite?",
  ]);
});

test("plan hace una sola llamada y mueve las preguntas a openQuestions", async () => {
  const harness = makeHarness([{
    status: "awaiting_human",
    snapshot: "snap",
    summary: "resumen",
    tasks: [],
    questions: [{ id: "scope", prompt: "¿Incluimos tests?", kind: "confirm" }],
  }]);

  const output = await planStage.run(
    { status: "completed", content: "# Snapshot", assumptions: [], questions: [] },
    harness.ctx,
  );

  assert.equal(harness.modelCalls(), 1);
  assert.equal(output.status, "completed");
  assert.deepEqual(output.questions, []);
  assert.deepEqual(output.openQuestions, ["Sin respuesta humana — ¿Incluimos tests?"]);
});

test("run trata awaiting_human con preguntas bloqueantes como blocked", async () => {
  const harness = makeHarness([{
    taskId: "T1",
    status: "awaiting_human",
    summary: "necesito elegir el patrón",
    questions: [{ id: "pattern", prompt: "¿Adapter o Facade?", kind: "choice", choices: ["adapter", "facade"] }],
  }]);

  const [output] = await runStage.run(PLAN_INPUT, harness.ctx);

  assert.equal(harness.modelCalls(), 1);
  assert.equal(output?.status, "blocked");
  assert.deepEqual(output?.questions, []);
  assert.deepEqual(output?.followUps, ["Sin respuesta humana — ¿Adapter o Facade?"]);
  assert.match(output?.summary ?? "", /Bloqueado sin decisión autónoma/);
});

test("run trata awaiting_human sin preguntas bloqueantes como completed", async () => {
  const harness = makeHarness([{
    taskId: "T1",
    status: "awaiting_human",
    summary: "hecho",
    assumptions: ["se asumió el default"],
    questions: [{ id: "nit", prompt: "¿Renombramos el archivo?", kind: "confirm", blocking: false }],
  }]);

  const [output] = await runStage.run(PLAN_INPUT, harness.ctx);

  assert.equal(output?.status, "completed");
  assert.deepEqual(output?.questions, []);
  assert.deepEqual(output?.assumptions, ["se asumió el default"]);
});

test("run reporta failed con assumptions vacías cuando el modelo no produce output", async () => {
  const harness = makeHarness([]);
  harness.ctx.model.generateObject = async () => {
    throw new Error("provider caído");
  };

  const [output] = await runStage.run(PLAN_INPUT, harness.ctx);

  assert.equal(output?.status, "failed");
  assert.deepEqual(output?.assumptions, []);
  assert.match(output?.summary ?? "", /provider caído/);
});
