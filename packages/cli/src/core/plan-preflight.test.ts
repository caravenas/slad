import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlanOutput, SnapshotOutput, type PlanArtifactEnvelope, type PlanTask } from "./types.js";
import { planHashOf, planInputDigestOf } from "../persistence/index.js";
import {
  preflightPlan,
  type PlanPreflightCode,
  type PlanPreflightIssue,
  type PlanPreflightReport,
} from "./plan-preflight.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<PlanTask> & { id: string }): PlanTask {
  return {
    title: `Task ${overrides.id}`,
    description: "do the thing",
    type: "implementation",
    priority: "medium",
    dependsOn: [],
    files: [`src/${overrides.id}.ts`],
    acceptanceCriteria: ["it works"],
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanOutput> = {}): PlanOutput {
  return PlanOutput.parse({
    snapshot: "mini-spec",
    summary: "a plan",
    tasks: [makeTask({ id: "T1" })],
    recommendedFirstTask: "T1",
    ...overrides,
  });
}

interface EnvelopeOverrides {
  plan?: PlanOutput;
  sessionId?: string;
  intent?: string;
  digest?: string;
  planHash?: string;
  status?: PlanArtifactEnvelope["approval"]["status"];
  decidedAt?: string | undefined;
}

function makeEnvelope(overrides: EnvelopeOverrides = {}): PlanArtifactEnvelope {
  const plan = overrides.plan ?? makePlan();
  const snapshot = SnapshotOutput.parse({ content: "mini-spec" });
  const intent = overrides.intent ?? "implement the feature";
  const status = overrides.status ?? "approved";
  const decidedAt = "decidedAt" in overrides ? overrides.decidedAt : "2026-01-02T00:00:00.000Z";

  // Built by hand instead of PlanArtifactEnvelope.parse so tests can corrupt
  // fields (empty sessionId, wrong digest) that the schema would reject.
  return {
    kind: "plan",
    schemaVersion: 2,
    planId: "s1-rev1",
    sessionId: overrides.sessionId ?? "s1",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    approval: {
      status,
      ...(decidedAt ? { decidedAt } : {}),
      planHash: overrides.planHash ?? planHashOf(plan),
    },
    input: {
      intent,
      snapshot,
      digest: overrides.digest ?? planInputDigestOf(intent, snapshot),
    },
    plan,
  };
}

function codes(issues: PlanPreflightIssue[]): PlanPreflightCode[] {
  return issues.map((issue) => issue.code);
}

function findIssue(issues: PlanPreflightIssue[], code: PlanPreflightCode): PlanPreflightIssue {
  const issue = issues.find((item) => item.code === code);
  assert.ok(issue, `expected issue ${code}, got: ${codes(issues).join(", ") || "none"}`);
  return issue;
}

function assertClean(report: PlanPreflightReport): void {
  assert.deepEqual(codes(report.blockers), []);
  assert.deepEqual(codes(report.warnings), []);
  assert.equal(report.ok, true);
}

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe("preflightPlan happy paths", () => {
  it("passes a healthy approved plan in run mode with no issues", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
      ],
      recommendedFirstTask: "T1",
    });
    assertClean(preflightPlan(makeEnvelope({ plan }), { mode: "run" }));
  });

  it("passes a healthy pending plan in approve mode with no issues", () => {
    assertClean(preflightPlan(makeEnvelope({ status: "pending", decidedAt: undefined }), { mode: "approve" }));
  });

  it("reports mode back and stays ok with warnings only", () => {
    const report = preflightPlan(makeEnvelope({ intent: "" }), { mode: "run" });
    assert.equal(report.mode, "run");
    assert.equal(report.ok, true);
    assert.ok(report.warnings.length > 0);
    assert.deepEqual(report.blockers, []);
  });
});

// ─── Envelope binding ────────────────────────────────────────────────────────

describe("preflightPlan envelope binding", () => {
  it("blocks an empty sessionId", () => {
    const report = preflightPlan(makeEnvelope({ sessionId: "  " }), { mode: "run" });
    findIssue(report.blockers, "envelope.session-id.missing");
    assert.equal(report.ok, false);
  });

  it("blocks a session id mismatch against the active session", () => {
    const report = preflightPlan(makeEnvelope({ sessionId: "s1" }), {
      mode: "run",
      expectedSession: { id: "s2", intent: "implement the feature" },
    });
    findIssue(report.blockers, "envelope.session-id.mismatch");
  });

  it("warns (not blocks) on an empty intent for legacy compatibility", () => {
    const report = preflightPlan(makeEnvelope({ intent: "" }), { mode: "run" });
    findIssue(report.warnings, "envelope.intent.empty");
    assert.equal(report.ok, true);
  });

  it("keeps the digest consistent for legacy plans with empty intent", () => {
    const report = preflightPlan(makeEnvelope({ intent: "" }), { mode: "run" });
    assert.ok(!codes(report.blockers).includes("envelope.digest.mismatch"));
  });

  it("blocks an intent mismatch against the active session", () => {
    const report = preflightPlan(makeEnvelope({ intent: "implement the feature" }), {
      mode: "run",
      expectedSession: { id: "s1", intent: "different intent" },
    });
    findIssue(report.blockers, "envelope.intent.mismatch");
  });

  it("blocks when the input digest does not match intent+snapshot", () => {
    const report = preflightPlan(makeEnvelope({ digest: "deadbeef" }), { mode: "run" });
    findIssue(report.blockers, "envelope.digest.mismatch");
  });

  it("blocks a digest computed over a different intent", () => {
    const snapshot = SnapshotOutput.parse({ content: "mini-spec" });
    const report = preflightPlan(
      makeEnvelope({ intent: "real intent", digest: planInputDigestOf("other intent", snapshot) }),
      { mode: "approve" },
    );
    findIssue(report.blockers, "envelope.digest.mismatch");
  });
});

// ─── Approval binding ────────────────────────────────────────────────────────

describe("preflightPlan approval in run mode", () => {
  it("blocks a pending plan", () => {
    const report = preflightPlan(makeEnvelope({ status: "pending" }), { mode: "run" });
    const issue = findIssue(report.blockers, "approval.status.not-approved");
    assert.match(issue.message, /pending/);
  });

  it("blocks a rejected plan", () => {
    const report = preflightPlan(makeEnvelope({ status: "rejected" }), { mode: "run" });
    findIssue(report.blockers, "approval.status.not-approved");
  });

  it("blocks a superseded plan", () => {
    const report = preflightPlan(makeEnvelope({ status: "superseded" }), { mode: "run" });
    findIssue(report.blockers, "approval.status.not-approved");
  });

  it("blocks an approval whose planHash no longer matches the plan body", () => {
    const report = preflightPlan(makeEnvelope({ planHash: "stale-hash" }), { mode: "run" });
    findIssue(report.blockers, "approval.hash.mismatch");
  });

  it("blocks a stale approval signal carried by readPlan", () => {
    const envelope = makeEnvelope({ status: "pending", decidedAt: undefined });
    const report = preflightPlan(envelope, {
      mode: "run",
      staleApproval: {
        status: "approved",
        planHash: "stale-hash",
        currentPlanHash: planHashOf(envelope.plan),
      },
    });
    findIssue(report.blockers, "approval.hash.mismatch");
  });

  it("warns when an approved plan has no decidedAt", () => {
    const report = preflightPlan(makeEnvelope({ decidedAt: undefined }), { mode: "run" });
    findIssue(report.warnings, "approval.decided-at.missing");
    assert.equal(report.ok, true);
  });
});

describe("preflightPlan approval in approve mode", () => {
  it("blocks approving a superseded plan", () => {
    const report = preflightPlan(makeEnvelope({ status: "superseded" }), { mode: "approve" });
    findIssue(report.blockers, "approval.status.superseded");
  });

  it("warns when the plan is already approved", () => {
    const report = preflightPlan(makeEnvelope({ status: "approved" }), { mode: "approve" });
    findIssue(report.warnings, "approval.status.already-approved");
    assert.equal(report.ok, true);
  });

  it("warns when the plan was previously rejected", () => {
    const report = preflightPlan(makeEnvelope({ status: "rejected" }), { mode: "approve" });
    findIssue(report.warnings, "approval.status.rejected");
    assert.equal(report.ok, true);
  });

  it("downgrades a stale planHash to a warning (approving re-binds it)", () => {
    const report = preflightPlan(
      makeEnvelope({ status: "pending", planHash: "stale-hash" }),
      { mode: "approve" },
    );
    findIssue(report.warnings, "approval.hash.stale");
    assert.ok(!codes(report.blockers).includes("approval.hash.mismatch"));
  });
});

// ─── Task graph ──────────────────────────────────────────────────────────────

describe("preflightPlan task graph", () => {
  it("blocks an empty task list in both run and approve modes", () => {
    const plan = makePlan({ tasks: [], recommendedFirstTask: undefined });
    const run = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(run.blockers, "plan.tasks.empty");

    const approve = preflightPlan(makeEnvelope({ plan }), { mode: "approve" });
    findIssue(approve.blockers, "plan.tasks.empty");
    assert.equal(approve.ok, false);
  });

  it("blocks a plan whose status is not completed in both run and approve modes", () => {
    const plan = makePlan({ status: "awaiting_human" });
    for (const mode of ["run", "approve"] as const) {
      const report = preflightPlan(makeEnvelope({ plan }), { mode });
      const issue = findIssue(report.blockers, "plan.status.not-completed");
      assert.match(issue.message, /awaiting_human/);
    }
  });

  it("blocks duplicate task ids, reporting each id once", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/a.ts"] }),
        makeTask({ id: "T1", files: ["src/b.ts"] }),
        makeTask({ id: "T1", files: ["src/c.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const duplicates = report.blockers.filter((issue) => issue.code === "task.id.duplicate");
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]?.taskId, "T1");
    assert.match(duplicates[0]!.message, /3 veces/);
  });

  it("blocks a dependency on a task that does not exist", () => {
    const plan = makePlan({
      tasks: [makeTask({ id: "T1", dependsOn: ["T9"] })],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const issue = findIssue(report.blockers, "task.deps.unknown");
    assert.equal(issue.taskId, "T1");
    assert.match(issue.message, /T9/);
  });

  it("blocks a task that depends on itself", () => {
    const plan = makePlan({ tasks: [makeTask({ id: "T1", dependsOn: ["T1"] })] });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.blockers, "task.deps.self");
  });

  it("warns on duplicate entries inside dependsOn", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1", "T1"], files: ["src/b.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const issue = findIssue(report.warnings, "task.deps.duplicate");
    assert.equal(issue.taskId, "T2");
  });

  it("blocks a two-node dependency cycle and lists its path", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", dependsOn: ["T2"], files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const issue = findIssue(report.blockers, "plan.deps.cycle");
    assert.match(issue.message, /T1 → T2 → T1|T2 → T1 → T2/);
  });

  it("blocks a longer cycle reachable through a chain", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T4"], files: ["src/b.ts"] }),
        makeTask({ id: "T3", dependsOn: ["T2"], files: ["src/c.ts"] }),
        makeTask({ id: "T4", dependsOn: ["T3"], files: ["src/d.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.blockers, "plan.deps.cycle");
  });

  it("does not report a cycle for a valid diamond DAG", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
        makeTask({ id: "T3", dependsOn: ["T1"], files: ["src/c.ts"] }),
        makeTask({ id: "T4", dependsOn: ["T2", "T3"], files: ["src/d.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    assert.ok(!codes(report.blockers).includes("plan.deps.cycle"));
  });

  it("blocks a recommendedFirstTask that does not exist", () => {
    const plan = makePlan({ recommendedFirstTask: "T9" });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.blockers, "plan.recommended-first-task.unknown");
  });

  it("warns when recommendedFirstTask has dependencies", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
      ],
      recommendedFirstTask: "T2",
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.warnings, "plan.recommended-first-task.has-deps");
  });

  it("warns when the plan does not recommend a first task", () => {
    const plan = makePlan({ recommendedFirstTask: undefined });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.warnings, "plan.recommended-first-task.missing");
  });
});

// ─── Declared files ──────────────────────────────────────────────────────────

describe("preflightPlan file declarations", () => {
  function reportForFiles(files: string[]): PlanPreflightReport {
    const plan = makePlan({ tasks: [makeTask({ id: "T1", files })] });
    return preflightPlan(makeEnvelope({ plan }), { mode: "run" });
  }

  it("blocks empty and whitespace-only entries", () => {
    const report = reportForFiles(["", "   "]);
    const empties = report.blockers.filter((issue) => issue.code === "task.files.empty");
    assert.equal(empties.length, 2);
  });

  it("blocks glob patterns", () => {
    for (const file of ["src/**/*.ts", "src/file?.ts", "src/{a,b}.ts", "src/[ab].ts", "!src/a.ts"]) {
      findIssue(reportForFiles([file]).blockers, "task.files.glob");
    }
  });

  it("blocks absolute, home and drive-letter paths", () => {
    for (const file of ["/etc/passwd", "~/notes.md", "C:/repo/a.ts", "c:x.ts"]) {
      findIssue(reportForFiles([file]).blockers, "task.files.absolute");
    }
  });

  it("blocks path traversal, including interior .. segments", () => {
    for (const file of ["../secret.ts", "src/../../etc/passwd", "src/../a.ts"]) {
      findIssue(reportForFiles([file]).blockers, "task.files.traversal");
    }
  });

  it("blocks backslash separators", () => {
    for (const file of ["src\\a.ts", "C:\\repo\\a.ts"]) {
      findIssue(reportForFiles([file]).blockers, "task.files.backslash");
    }
  });

  it("blocks entries that resolve to the workspace root", () => {
    for (const file of [".", "./", "./."]) {
      findIssue(reportForFiles([file]).blockers, "task.files.root");
    }
  });

  it("blocks cosmetic variants that normalize cleanly", () => {
    for (const file of ["./src/a.ts", "src//a.ts", "src/a.ts/", " src/a.ts"]) {
      const report = reportForFiles([file]);
      const issue = findIssue(report.blockers, "task.files.unnormalized");
      assert.match(issue.message, /src\/a\.ts/);
    }
  });

  it("warns on duplicate files within a task, comparing normalized forms", () => {
    const report = reportForFiles(["src/a.ts", "./src/a.ts"]);
    findIssue(report.warnings, "task.files.duplicate");
  });

  it("warns when an implementation task in a multi-task plan declares no files", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: [] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const issue = findIssue(report.warnings, "task.files.none");
    assert.equal(issue.taskId, "T1");
  });

  it("does not warn about missing files for research/review tasks or single-task plans", () => {
    const research = makePlan({
      tasks: [
        makeTask({ id: "T1", type: "research", files: [] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
      ],
    });
    const singleTask = makePlan({ tasks: [makeTask({ id: "T1", files: [] })] });
    for (const plan of [research, singleTask]) {
      const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
      assert.ok(!codes(report.warnings).includes("task.files.none"));
    }
  });
});

// ─── Ownership overlap ───────────────────────────────────────────────────────

describe("preflightPlan ownership overlap", () => {
  it("warns when two independent tasks declare the same file", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/shared.ts", "src/a.ts"] }),
        makeTask({ id: "T2", files: ["src/shared.ts", "src/b.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const issue = findIssue(report.warnings, "plan.ownership.overlap");
    assert.match(issue.message, /T1/);
    assert.match(issue.message, /T2/);
    assert.match(issue.message, /src\/shared\.ts/);
  });

  it("compares normalized paths across tasks", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/shared.ts"] }),
        makeTask({ id: "T2", files: ["./src/shared.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.warnings, "plan.ownership.overlap");
  });

  it("does not warn when the overlapping tasks are directly dependent", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/shared.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/shared.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    assert.ok(!codes(report.warnings).includes("plan.ownership.overlap"));
  });

  it("does not warn when the overlapping tasks are transitively dependent", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/shared.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
        makeTask({ id: "T3", dependsOn: ["T2"], files: ["src/shared.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    assert.ok(!codes(report.warnings).includes("plan.ownership.overlap"));
  });

  it("warns once per overlapping pair", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", files: ["src/shared.ts"] }),
        makeTask({ id: "T2", files: ["src/shared.ts"] }),
        makeTask({ id: "T3", files: ["src/shared.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    const overlaps = report.warnings.filter((issue) => issue.code === "plan.ownership.overlap");
    assert.equal(overlaps.length, 3);
  });

  it("survives cyclic dependencies without hanging and still reports overlap for unrelated tasks", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", dependsOn: ["T2"], files: ["src/a.ts"] }),
        makeTask({ id: "T2", dependsOn: ["T1"], files: ["src/b.ts"] }),
        makeTask({ id: "T3", files: ["src/c.ts", "src/shared.ts"] }),
        makeTask({ id: "T4", files: ["src/d.ts", "src/shared.ts"] }),
      ],
    });
    const report = preflightPlan(makeEnvelope({ plan }), { mode: "run" });
    findIssue(report.blockers, "plan.deps.cycle");
    findIssue(report.warnings, "plan.ownership.overlap");
  });
});

// ─── Aggregation ─────────────────────────────────────────────────────────────

describe("preflightPlan aggregation", () => {
  it("accumulates issues from every check in one report", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", dependsOn: ["T9"], files: ["/abs.ts", "src/*.ts"] }),
        makeTask({ id: "T2", files: ["src/x.ts"] }),
        makeTask({ id: "T3", files: ["src/x.ts"] }),
      ],
      recommendedFirstTask: undefined,
    });
    const report = preflightPlan(
      makeEnvelope({ plan, status: "pending", intent: "" }),
      { mode: "run" },
    );

    assert.equal(report.ok, false);
    for (const code of [
      "approval.status.not-approved",
      "task.deps.unknown",
      "task.files.absolute",
      "task.files.glob",
    ] as const) {
      findIssue(report.blockers, code);
    }
    for (const code of [
      "envelope.intent.empty",
      "plan.recommended-first-task.missing",
      "plan.ownership.overlap",
    ] as const) {
      findIssue(report.warnings, code);
    }
  });
});
