import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanOutput, SnapshotOutput, type PlanArtifactEnvelope, type PlanTask } from "../core/types.js";
import { planHashOf, planInputDigestOf, readPlan, writePendingPlan } from "../persistence/index.js";
import { resetDocsRootCache } from "../persistence/layout.js";
import { appendArtifact, createSession, saveSession } from "../core/session.js";
import { gatePlanPreflight } from "../core/plan-preflight.js";
import { planCommand } from "./plan.js";
import { runCommand } from "./run.js";

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
  digest?: string;
  planHash?: string;
  status?: PlanArtifactEnvelope["approval"]["status"];
}

function makeEnvelope(overrides: EnvelopeOverrides = {}): PlanArtifactEnvelope {
  const plan = overrides.plan ?? makePlan();
  const snapshot = SnapshotOutput.parse({ content: "mini-spec" });
  const intent = "implement the feature";
  return {
    kind: "plan",
    schemaVersion: 2,
    planId: "s1-rev1",
    sessionId: "s1",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    approval: {
      status: overrides.status ?? "approved",
      decidedAt: "2026-01-02T00:00:00.000Z",
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

function blockerCodes(gate: ReturnType<typeof gatePlanPreflight>): string[] {
  return gate.blockers.map((issue) => issue.code);
}

// ─── gatePlanPreflight: bypass policy ────────────────────────────────────────

describe("gatePlanPreflight", () => {
  it("blocks an unapproved plan in run mode without bypass", () => {
    const gate = gatePlanPreflight(makeEnvelope({ status: "pending" }), "run");
    assert.equal(gate.ok, false);
    assert.deepEqual(blockerCodes(gate), ["approval.status.not-approved"]);
    assert.deepEqual(gate.bypassed, []);
  });

  it("bypass skips only the missing-approval blocker", () => {
    const gate = gatePlanPreflight(makeEnvelope({ status: "pending" }), "run", { bypass: true });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.bypassed.map((issue) => issue.code), ["approval.status.not-approved"]);
  });

  it("bypass never skips a digest mismatch", () => {
    const envelope = makeEnvelope({ status: "pending", digest: "0".repeat(64) });
    const gate = gatePlanPreflight(envelope, "run", { bypass: true });
    assert.equal(gate.ok, false);
    assert.deepEqual(blockerCodes(gate), ["envelope.digest.mismatch"]);
    assert.deepEqual(gate.bypassed.map((issue) => issue.code), ["approval.status.not-approved"]);
  });

  it("bypass never skips a stale approval hash", () => {
    const envelope = makeEnvelope({ planHash: "0".repeat(64) });
    const gate = gatePlanPreflight(envelope, "run", { bypass: true });
    assert.equal(gate.ok, false);
    assert.deepEqual(blockerCodes(gate), ["approval.hash.mismatch"]);
  });

  it("bypass never skips a stale approval normalized by readPlan", () => {
    const envelope = makeEnvelope({ status: "pending" });
    const gate = gatePlanPreflight(envelope, "run", {
      bypass: true,
      staleApproval: {
        status: "approved",
        planHash: "0".repeat(64),
        currentPlanHash: planHashOf(envelope.plan),
      },
    });
    assert.equal(gate.ok, false);
    assert.deepEqual(blockerCodes(gate), ["approval.hash.mismatch"]);
    assert.deepEqual(gate.bypassed.map((issue) => issue.code), ["approval.status.not-approved"]);
  });

  it("blocks a plan from another session", () => {
    const gate = gatePlanPreflight(makeEnvelope(), "run", {
      expectedSession: { id: "s2", intent: "implement the feature" },
    });
    assert.equal(gate.ok, false);
    assert.deepEqual(blockerCodes(gate), ["envelope.session-id.mismatch"]);
  });

  it("bypass never skips a dependency cycle", () => {
    const plan = makePlan({
      tasks: [
        makeTask({ id: "T1", dependsOn: ["T2"] }),
        makeTask({ id: "T2", dependsOn: ["T1"] }),
      ],
    });
    const gate = gatePlanPreflight(makeEnvelope({ plan }), "run", { bypass: true });
    assert.equal(gate.ok, false);
    assert.ok(blockerCodes(gate).includes("plan.deps.cycle"));
  });

  it("bypass never skips an absolute declared path", () => {
    const plan = makePlan({ tasks: [makeTask({ id: "T1", files: ["/etc/passwd"] })] });
    const gate = gatePlanPreflight(makeEnvelope({ plan }), "run", { bypass: true });
    assert.equal(gate.ok, false);
    assert.deepEqual(blockerCodes(gate), ["task.files.absolute"]);
  });

  it("warnings never block in approve mode", () => {
    const gate = gatePlanPreflight(makeEnvelope({ status: "approved" }), "approve");
    assert.equal(gate.ok, true);
    assert.ok(gate.report.warnings.some((issue) => issue.code === "approval.status.already-approved"));
  });
});

// ─── Command wiring: exit behavior ───────────────────────────────────────────

describe("preflight wiring in approve/run commands", () => {
  const originalCwd = process.cwd();
  const originalDocsPath = process.env.SLAD_DOCS_PATH;
  const originalExitCode = process.exitCode;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "slad-preflight-wiring-"));
    dir = fs.realpathSync(dir);
    process.env.SLAD_DOCS_PATH = path.join(dir, "docs");
    resetDocsRootCache();
    process.chdir(dir);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalDocsPath === undefined) {
      delete process.env.SLAD_DOCS_PATH;
    } else {
      process.env.SLAD_DOCS_PATH = originalDocsPath;
    }
    resetDocsRootCache();
    process.exitCode = originalExitCode;
    await rm(dir, { recursive: true, force: true });
  });

  async function seedSessionWithPendingPlan(plan: PlanOutput = makePlan()): Promise<string> {
    const session = createSession("implement the feature", dir);
    const written = await writePendingPlan({
      sessionId: session.id,
      intent: session.intent,
      snapshot: SnapshotOutput.parse({ content: "mini-spec" }),
      plan,
    });
    saveSession(appendArtifact(session, "plan", written.ref.path), dir);
    return written.ref.path;
  }

  function tamperIntent(planPath: string): void {
    const raw = JSON.parse(fs.readFileSync(planPath, "utf8")) as { input: { intent: string } };
    raw.input.intent = "tampered intent";
    fs.writeFileSync(planPath, JSON.stringify(raw));
  }

  it("run refuses an unapproved plan before creating any manifest", async () => {
    await seedSessionWithPendingPlan();

    await runCommand({});

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("run rejects --worktrees without --parallel before creating any manifest", async () => {
    await seedSessionWithPendingPlan();
    await planCommand({ approve: true });
    process.exitCode = undefined;

    await runCommand({ worktrees: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("run rejects --keep-worktrees without --worktrees before creating any manifest", async () => {
    await seedSessionWithPendingPlan();
    await planCommand({ approve: true });
    process.exitCode = undefined;

    await runCommand({ parallel: true, keepWorktrees: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("run rejects review actions combined with execution flags before creating any manifest", async () => {
    await runCommand({ review: "run_x", parallel: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("run rejects --from-review without worktree parallel mode before creating any manifest", async () => {
    await runCommand({ fromReview: "run_x", parallel: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("run with --bypass still refuses a tampered plan and creates no manifest", async () => {
    const planPath = await seedSessionWithPendingPlan();
    tamperIntent(planPath);

    await runCommand({ bypass: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("run with --bypass refuses a stale approval normalized by readPlan", async () => {
    const planPath = await seedSessionWithPendingPlan();
    await planCommand({ approve: true });
    process.exitCode = undefined;

    const raw = JSON.parse(fs.readFileSync(planPath, "utf8")) as { plan: { tasks: { files: string[] }[] } };
    raw.plan.tasks[0]!.files.push("src/extra.ts");
    fs.writeFileSync(planPath, JSON.stringify(raw, null, 2), "utf8");

    await runCommand({ bypass: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, ".slad-os", "runs")), false);
  });

  it("approve passes preflight and records the approval", async () => {
    const planPath = await seedSessionWithPendingPlan();

    await planCommand({ approve: true });

    assert.equal(process.exitCode, undefined);
    const after = await readPlan(planPath);
    assert.equal(after.value.approval.status, "approved");
  });

  it("approve blocks on a tampered plan and leaves it pending", async () => {
    const planPath = await seedSessionWithPendingPlan();
    tamperIntent(planPath);

    await planCommand({ approve: true });

    assert.equal(process.exitCode, 1);
    const after = await readPlan(planPath);
    assert.equal(after.value.approval.status, "pending");
  });

  it("approve blocks a plan with no tasks and leaves it pending", async () => {
    const planPath = await seedSessionWithPendingPlan(makePlan({ tasks: [], recommendedFirstTask: undefined }));

    await planCommand({ approve: true });

    assert.equal(process.exitCode, 1);
    const after = await readPlan(planPath);
    assert.equal(after.value.approval.status, "pending");
  });

  it("approve blocks a plan whose status is not completed and leaves it pending", async () => {
    const planPath = await seedSessionWithPendingPlan(makePlan({ status: "awaiting_human" }));

    await planCommand({ approve: true });

    assert.equal(process.exitCode, 1);
    const after = await readPlan(planPath);
    assert.equal(after.value.approval.status, "pending");
  });

  it("exits 1 when --approve and --reject are combined", async () => {
    await seedSessionWithPendingPlan();

    await planCommand({ approve: true, reject: true });

    assert.equal(process.exitCode, 1);
  });

  it("exits 1 on approve without an active session", async () => {
    await planCommand({ approve: true });

    assert.equal(process.exitCode, 1);
  });

  it("exits 1 on approve when --skip-session is set", async () => {
    await seedSessionWithPendingPlan();

    await planCommand({ approve: true, skipSession: true });

    assert.equal(process.exitCode, 1);
  });

  it("exits 1 on reject when the active session has no plan", async () => {
    createSession("implement the feature", dir);

    await planCommand({ reject: true });

    assert.equal(process.exitCode, 1);
  });

  // ─── --check: read-only preflight ──────────────────────────────────────────

  async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines;
  }

  it("check passes on a valid pending plan without mutating it", async () => {
    const planPath = await seedSessionWithPendingPlan();
    const before = fs.readFileSync(planPath, "utf8");

    await planCommand({ check: true });

    assert.equal(process.exitCode, undefined);
    assert.equal(fs.readFileSync(planPath, "utf8"), before);
    const after = await readPlan(planPath);
    assert.equal(after.value.approval.status, "pending");
  });

  it("check exits 1 on a tampered plan and leaves it untouched", async () => {
    const planPath = await seedSessionWithPendingPlan();
    tamperIntent(planPath);
    const before = fs.readFileSync(planPath, "utf8");

    await planCommand({ check: true });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.readFileSync(planPath, "utf8"), before);
  });

  it("check exits 1 on a plan with blockers in the task graph", async () => {
    await seedSessionWithPendingPlan(makePlan({ tasks: [], recommendedFirstTask: undefined }));

    await planCommand({ check: true });

    assert.equal(process.exitCode, 1);
  });

  it("check --json prints the gate as JSON and exits 0 when ok", async () => {
    await seedSessionWithPendingPlan();

    const lines = await captureStdout(() => planCommand({ check: true, json: true }));

    assert.equal(process.exitCode, undefined);
    const parsed = JSON.parse(lines.join("\n")) as {
      ok: boolean;
      mode: string;
      blockers: unknown[];
      planPath: string;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, "approve");
    assert.deepEqual(parsed.blockers, []);
    assert.ok(parsed.planPath.length > 0);
  });

  it("check --json reports blockers and exits 1", async () => {
    const planPath = await seedSessionWithPendingPlan();
    tamperIntent(planPath);

    const lines = await captureStdout(() => planCommand({ check: true, json: true }));

    assert.equal(process.exitCode, 1);
    const parsed = JSON.parse(lines.join("\n")) as { ok: boolean; blockers: { code: string }[] };
    assert.equal(parsed.ok, false);
    assert.ok(parsed.blockers.some((issue) => issue.code === "envelope.intent.mismatch"));
  });

  it("exits 1 when --check is combined with --approve or --reject", async () => {
    const planPath = await seedSessionWithPendingPlan();

    await planCommand({ check: true, approve: true });
    assert.equal(process.exitCode, 1);

    process.exitCode = undefined;
    await planCommand({ check: true, reject: true });
    assert.equal(process.exitCode, 1);

    const after = await readPlan(planPath);
    assert.equal(after.value.approval.status, "pending");
  });

  it("exits 1 on check without an active session", async () => {
    await planCommand({ check: true });

    assert.equal(process.exitCode, 1);
  });

  it("exits 1 on check when --skip-session is set", async () => {
    await seedSessionWithPendingPlan();

    await planCommand({ check: true, skipSession: true });

    assert.equal(process.exitCode, 1);
  });
});
