import assert from "node:assert/strict";
import test from "node:test";
import { definePipeline, defineStage, runPipeline } from "./index.js";
import type { ModelProvider } from "@slad/model-providers";

function makeFakeProvider(response = "ok", inputTokens = 1000, outputTokens = 500): ModelProvider {
  return {
    name: "anthropic" as ModelProvider["name"],
    complete: async (_messages, opts) => {
      opts?.onUsage?.(inputTokens, outputTokens);
      return response;
    },
  };
}

class MemoryCache {
  private readonly values = new Map<string, unknown>();
  get(key: string): unknown | undefined {
    return this.values.get(key);
  }
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

test("runPipeline executes stages in order and returns the final output", async () => {
  const addOne = defineStage<number, number>({
    id: "add-one",
    async run(input, ctx) {
      await ctx.emitArtifact("input", input);
      return input + 1;
    },
  });
  const double = defineStage<number, number>({
    id: "double",
    async run(input) {
      return input * 2;
    },
  });

  const result = await runPipeline<number, number>({ stages: [addOne, double], input: 2 });

  assert.equal(result.status, "completed");
  assert.equal(result.output, 6);
  assert.deepEqual(result.stages.map((stage) => stage.stageId), ["add-one", "double"]);
  assert.equal(result.artifacts[0]?.name, "input");
});

test("runPipeline resolves string stage refs through a registry", async () => {
  const pipeline = definePipeline({
    stages: ["trim", "upper"],
    registry: {
      trim: defineStage<string, string>({ id: "trim", async run(input) { return input.trim(); } }),
      upper: defineStage<string, string>({ id: "upper", async run(input) { return input.toUpperCase(); } }),
    },
  });

  const result = await runPipeline<string, string>({ ...pipeline, input: " hello " });

  assert.equal(result.output, "HELLO");
});

test("runPipeline uses a cache store when stage cache is enabled", async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const stage = defineStage<number, number>({
    id: "expensive",
    cache: { key: (input) => `expensive:${input}` },
    async run(input) {
      calls += 1;
      return input * 10;
    },
  });

  const first = await runPipeline<number, number>({ stages: [stage], input: 3, cache });
  const second = await runPipeline<number, number>({ stages: [stage], input: 3, cache });

  assert.equal(first.output, 30);
  assert.equal(second.output, 30);
  assert.equal(second.stages[0]?.status, "cached");
  assert.equal(calls, 1);
});

// Budget policy: maxModelCalls enforcement
test("runPipeline enforces maxModelCalls and fails the stage", async () => {
  const provider = makeFakeProvider();
  const stage = defineStage<number, number>({
    id: "model-stage",
    async run(input, ctx) {
      await ctx.model.generateText({ system: "s", input });
      return input;
    },
  });

  const result = await runPipeline<number, number>({
    stages: [stage, stage],
    input: 1,
    services: { provider },
    policies: { budget: { maxModelCalls: 1 } },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.stages.some((s) => s.status === "failed"));
});

// Budget policy: maxUsd enforcement via onUsage
test("runPipeline enforces maxUsd using BudgetTracker and fails the stage", async () => {
  // provider reports 1M input + 1M output tokens per call → _default pricing: $3 + $15 = $18 per call
  const provider = makeFakeProvider("ok", 1_000_000, 1_000_000);
  const stage = defineStage<number, number>({
    id: "expensive-stage",
    async run(input, ctx) {
      await ctx.model.generateText({ system: "s", input });
      return input;
    },
  });

  // maxUsd of $1 — first call costs $18, so second stage model call should be blocked
  const result = await runPipeline<number, number>({
    stages: [stage, stage],
    input: 1,
    services: { provider },
    policies: { budget: { maxUsd: 1 } },
  });

  assert.equal(result.status, "failed");
  // First stage completed successfully, second stage failed when budget was exceeded
  assert.equal(result.stages[0]?.status, "completed");
  assert.equal(result.stages[1]?.status, "failed");
  assert.ok(result.stages[1]?.error?.message.includes("maxUsd"));
});

// Budget policy: maxUsd not exceeded when cost is within limit
test("runPipeline does not fail when cost is within maxUsd", async () => {
  // 100 input + 50 output tokens per call at _default pricing: ~$0.00000045 + ~$0.00000075 per call
  const provider = makeFakeProvider("ok", 100, 50);
  const stage = defineStage<number, number>({
    id: "cheap-stage",
    async run(input, ctx) {
      await ctx.model.generateText({ system: "s", input });
      return input + 1;
    },
  });

  const result = await runPipeline<number, number>({
    stages: [stage, stage],
    input: 0,
    services: { provider },
    policies: { budget: { maxUsd: 10 } },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output, 2);
});
