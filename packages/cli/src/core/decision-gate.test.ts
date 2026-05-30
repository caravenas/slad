import test from "node:test";
import assert from "node:assert/strict";
import type { DecisionRecord } from "@slad/shared";
import { findGatingDecisions, runDecisionGate } from "./decision-gate.js";

function makeDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "test-decision",
    stage: "plan",
    decision: "Elegimos el enfoque A",
    alternatives: [],
    rationale: "",
    evidence: [],
    reversibility: "trivial",
    supersedes: [],
    ...overrides,
  };
}

test("findGatingDecisions: returns only hard and permanent decisions", () => {
  const decisions = [
    makeDecision({ id: "d1", reversibility: "trivial" }),
    makeDecision({ id: "d2", reversibility: "moderate" }),
    makeDecision({ id: "d3", reversibility: "hard" }),
    makeDecision({ id: "d4", reversibility: "permanent" }),
  ];

  const gating = findGatingDecisions(decisions);
  assert.equal(gating.length, 2);
  assert.equal(gating[0]!.id, "d3");
  assert.equal(gating[1]!.id, "d4");
});

test("findGatingDecisions: returns empty array when no hard/permanent decisions", () => {
  const decisions = [
    makeDecision({ reversibility: "trivial" }),
    makeDecision({ reversibility: "moderate" }),
  ];
  assert.deepEqual(findGatingDecisions(decisions), []);
});

test("findGatingDecisions: returns empty array for empty input", () => {
  assert.deepEqual(findGatingDecisions([]), []);
});

test("runDecisionGate: returns approved immediately when no gating decisions", async () => {
  const decisions = [
    makeDecision({ reversibility: "trivial" }),
    makeDecision({ reversibility: "moderate" }),
  ];
  const result = await runDecisionGate(decisions, "Plan");
  assert.equal(result, "approved");
});

test("runDecisionGate: returns paused in non-interactive env when hard decision present", async () => {
  // In test environment stdin/stdout are not TTYs, so canUseInteractiveHitl() === false
  const decisions = [makeDecision({ reversibility: "hard", id: "risky-decision" })];
  const result = await runDecisionGate(decisions, "Plan");
  assert.equal(result, "paused");
});

test("runDecisionGate: returns paused in non-interactive env when permanent decision present", async () => {
  const decisions = [makeDecision({ reversibility: "permanent", id: "irreversible-decision" })];
  const result = await runDecisionGate(decisions, "Explore");
  assert.equal(result, "paused");
});

test("runDecisionGate: returns approved for empty decisions array", async () => {
  const result = await runDecisionGate([], "Plan");
  assert.equal(result, "approved");
});
