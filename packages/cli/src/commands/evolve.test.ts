import test from "node:test";
import assert from "node:assert/strict";
import type { DecisionRecord } from "@slad/shared";
import { decisionToWikiEntry } from "./evolve.js";

function makeDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "dec-001",
    stage: "plan",
    decision: "Use PostgreSQL for persistence",
    alternatives: [],
    rationale: "",
    evidence: [],
    reversibility: "hard",
    supersedes: [],
    ...overrides,
  };
}

test("decisionToWikiEntry: target follows wiki/decisions/{id}.md pattern", () => {
  const entry = decisionToWikiEntry(makeDecision({ id: "arch-db-001" }));
  assert.equal(entry.target, "wiki/decisions/arch-db-001.md");
});

test("decisionToWikiEntry: changeType is always create", () => {
  const entry = decisionToWikiEntry(makeDecision());
  assert.equal(entry.changeType, "create");
});

test("decisionToWikiEntry: content includes decision text and reversibility", () => {
  const decision = makeDecision({
    decision: "Use PostgreSQL for persistence",
    reversibility: "permanent",
    stage: "explore",
  });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.content, /Use PostgreSQL for persistence/);
  assert.match(entry.content, /permanent/);
  assert.match(entry.content, /explore/);
});

test("decisionToWikiEntry: includes rationale when present", () => {
  const decision = makeDecision({ rationale: "Lower operational cost than DynamoDB" });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.content, /Lower operational cost than DynamoDB/);
});

test("decisionToWikiEntry: omits rationale section when empty", () => {
  const decision = makeDecision({ rationale: "" });
  const entry = decisionToWikiEntry(decision);
  assert.doesNotMatch(entry.content, /## Rationale/);
});

test("decisionToWikiEntry: includes alternatives when present", () => {
  const decision = makeDecision({
    alternatives: [
      { option: "MySQL", rejectedBecause: "No JSONB support" },
      { option: "SQLite", rejectedBecause: "Not suitable for multi-process" },
    ],
  });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.content, /Alternatives Considered/);
  assert.match(entry.content, /MySQL/);
  assert.match(entry.content, /No JSONB support/);
});

test("decisionToWikiEntry: includes evidence when present", () => {
  const decision = makeDecision({
    evidence: [
      { kind: "explore-output", ref: "session-abc/explores/2026-explore.json" },
      { kind: "human-answer", ref: "q-001" },
    ],
  });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.content, /Evidence/);
  assert.match(entry.content, /explore-output/);
  assert.match(entry.content, /human-answer/);
});

test("decisionToWikiEntry: includes confidence percentage when provided", () => {
  const decision = makeDecision({ confidence: 0.85 });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.content, /85%/);
});

test("decisionToWikiEntry: omits confidence section when absent", () => {
  const decision = makeDecision({ confidence: undefined });
  const entry = decisionToWikiEntry(decision);
  assert.doesNotMatch(entry.content, /Confidence/);
});

test("decisionToWikiEntry: includes supersedes when present", () => {
  const decision = makeDecision({ supersedes: ["dec-000", "dec-pre-001"] });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.content, /Supersedes/);
  assert.match(entry.content, /dec-000/);
});

test("decisionToWikiEntry: rationale mentions stage and reversibility", () => {
  const decision = makeDecision({ stage: "run", reversibility: "permanent" });
  const entry = decisionToWikiEntry(decision);
  assert.match(entry.rationale, /permanent/);
  assert.match(entry.rationale, /run/);
});
