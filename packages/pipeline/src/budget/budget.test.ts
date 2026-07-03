import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BudgetTracker } from "./budget.js";

describe("BudgetTracker", () => {
  it("acumula tokens y calcula costo correctamente para claude-sonnet-4-5", () => {
    const tracker = new BudgetTracker("claude-sonnet-4-5");
    // $3.0 / 1M input, $15.0 / 1M output
    tracker.record("explore", 1_000_000, 100_000);
    const state = tracker.getState();
    assert.equal(state.inputTokens, 1_000_000);
    assert.equal(state.outputTokens, 100_000);
    // cost = (1e6 / 1e6) * 3.0 + (1e5 / 1e6) * 15.0 = 3.0 + 1.5 = 4.5
    assert.ok(Math.abs(state.estimatedCostUsd - 4.5) < 0.0001);
  });

  it("acumula por stage correctamente", () => {
    const tracker = new BudgetTracker("gpt-4o");
    tracker.record("explore", 100, 50);
    tracker.record("explore", 200, 100);
    tracker.record("plan", 300, 150);

    const state = tracker.getState();
    assert.equal(state.byStage["explore"]?.calls, 2);
    assert.equal(state.byStage["explore"]?.inputTokens, 300);
    assert.equal(state.byStage["plan"]?.calls, 1);
    assert.equal(state.byStage["plan"]?.inputTokens, 300);
  });

  it("isExceeded retorna true cuando el costo supera maxCostUsd", () => {
    const tracker = new BudgetTracker("claude-sonnet-4-5", 0.001); // $0.001 max
    tracker.record("run", 10_000, 5_000); // ~$0.03 + $0.075 > $0.001
    assert.ok(tracker.isExceeded());
  });

  it("isExceeded retorna false cuando está bajo el budget", () => {
    const tracker = new BudgetTracker("claude-sonnet-4-5", 100); // $100 max
    tracker.record("run", 100, 50); // tiny amount
    assert.ok(!tracker.isExceeded());
  });

  it("isExceeded retorna true cuando supera maxTokens", () => {
    const tracker = new BudgetTracker("gpt-4o-mini", 0, 1000); // 1000 tokens max
    tracker.record("run", 600, 500); // 1100 total > 1000
    assert.ok(tracker.isExceeded());
  });

  it("isExceeded retorna false con maxCostUsd=0 y maxTokens=0 (sin límite)", () => {
    const tracker = new BudgetTracker("gpt-4o", 0, 0);
    tracker.record("run", 10_000_000, 5_000_000);
    assert.ok(!tracker.isExceeded());
  });

  it("usa pricing de fallback _default para modelos desconocidos", () => {
    const tracker = new BudgetTracker("modelo-inexistente-xyz", 5.0);
    // _default: $3.0 input, $15.0 output — no debe lanzar error
    tracker.record("stage", 100, 50);
    const state = tracker.getState();
    assert.ok(state.estimatedCostUsd > 0);
    assert.ok(!tracker.isExceeded()); // 100/1M * 3 + 50/1M * 15 << $5
  });

  it("warning retorna null cuando está bajo el 80%", () => {
    const tracker = new BudgetTracker("gpt-4o-mini", 1.0);
    tracker.record("stage", 100, 50); // negligible cost
    assert.equal(tracker.warning(), null);
  });

  it("warning retorna string cuando supera el 80%", () => {
    const tracker = new BudgetTracker("claude-sonnet-4-5", 0.01); // $0.01 max
    tracker.record("stage", 500_000, 500_000); // ~$9 >> $0.01
    const w = tracker.warning();
    assert.ok(w !== null);
    assert.ok(w!.includes("Budget:"));
  });

  it("getState retorna una copia (no mutate)", () => {
    const tracker = new BudgetTracker("gpt-4o");
    tracker.record("s", 100, 50);
    const s1 = tracker.getState();
    tracker.record("s", 100, 50);
    const s2 = tracker.getState();
    // s1 should not be affected by the second record
    assert.notEqual(s1.inputTokens, s2.inputTokens);
  });
});
