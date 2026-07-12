import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approvePlan,
  planHashOf,
  readArtifact,
  readPlan,
  rejectPlan,
  writeArtifact,
  writePendingPlan,
} from "./index.js";
import { SladError } from "../core/errors.js";
import { resetDocsRootCache } from "./layout.js";
import type { PlanOutput, SnapshotOutput } from "../core/types.js";

const SESSION_ID = "2026-07-12_plan-session";
const CREATED_AT = "2026-07-12T12:00:00.000Z";
const DECIDED_AT = "2026-07-12T12:30:00.000Z";

function makeSnapshot(overrides: Partial<SnapshotOutput> = {}): SnapshotOutput {
  return {
    status: "completed",
    content: "The cache layer keys on userId only; no tenant salt.",
    assumptions: ["Single-tenant deployments only"],
    questions: [],
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanOutput> = {}): PlanOutput {
  return {
    status: "completed",
    snapshot: "The cache layer keys on userId only; no tenant salt.",
    summary: "Add a tenant salt to the cache key generator.",
    tasks: [
      {
        id: "T1",
        title: "Salt cache keys with tenantId",
        description: "Thread tenantId through buildCacheKey().",
        type: "implementation",
        priority: "high",
        dependsOn: [],
        files: ["src/cache/keys.ts"],
        acceptanceCriteria: ["Keys for two tenants never collide"],
      },
    ],
    verification: ["pnpm test"],
    risks: ["Existing cache entries are invalidated"],
    openQuestions: [],
    questions: [],
    decisions: [],
    ...overrides,
  };
}

function writePendingFixture(overrides: Partial<PlanOutput> = {}) {
  return writePendingPlan({
    sessionId: SESSION_ID,
    intent: "Prevent cross-tenant cache collisions",
    snapshot: makeSnapshot(),
    plan: makePlan(overrides),
    createdAt: CREATED_AT,
  });
}

describe("persistence/plan", () => {
  let tmpDir: string;
  let previousDocsPath: string | undefined;

  beforeEach(() => {
    resetDocsRootCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-plan-test-"));
    previousDocsPath = process.env.SLAD_DOCS_PATH;
    process.env.SLAD_DOCS_PATH = path.join(tmpDir, "docs");
  });

  afterEach(() => {
    resetDocsRootCache();
    if (previousDocsPath === undefined) {
      delete process.env.SLAD_DOCS_PATH;
    } else {
      process.env.SLAD_DOCS_PATH = previousDocsPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a plan as pending and reads it back intact", async () => {
    const written = await writePendingFixture();
    const { value, legacy, warnings } = await readPlan(written.ref.path);

    assert.equal(legacy, false);
    assert.deepEqual(warnings, []);
    assert.equal(value.schemaVersion, 2);
    assert.equal(value.revision, 1);
    assert.equal(value.planId, `${SESSION_ID}-r1`);
    assert.equal(value.sessionId, SESSION_ID);
    assert.equal(value.createdAt, CREATED_AT);
    assert.equal(value.supersedesPlanId, undefined);
    assert.equal(value.approval.status, "pending");
    assert.equal(value.approval.decidedAt, undefined);
    assert.equal(value.approval.planHash, planHashOf(makePlan()));
    assert.equal(value.input.intent, "Prevent cross-tenant cache collisions");
    assert.deepEqual(value.input.snapshot, makeSnapshot());
    assert.deepEqual(value.plan, makePlan());
  });

  it("hashes the plan body deterministically and independently of key order", async () => {
    const plan = makePlan();
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(plan).reverse())),
    ) as PlanOutput;

    assert.equal(planHashOf(plan), planHashOf(plan));
    assert.equal(planHashOf(plan), planHashOf(reordered));
    assert.notEqual(planHashOf(plan), planHashOf(makePlan({ summary: "Something else" })));
  });

  it("records an approval bound to the plan hash", async () => {
    const written = await writePendingFixture();
    const approved = await approvePlan(written.ref.path, {
      reason: "Salt design is sound",
      decidedAt: DECIDED_AT,
    });

    assert.equal(approved.approval.status, "approved");
    assert.equal(approved.approval.decidedAt, DECIDED_AT);
    assert.equal(approved.approval.reason, "Salt design is sound");
    assert.equal(approved.approval.planHash, planHashOf(makePlan()));
    assert.equal(approved.updatedAt, DECIDED_AT);

    const reread = await readPlan(written.ref.path);
    assert.deepEqual(reread.value, approved);
    assert.deepEqual(reread.warnings, []);
  });

  it("records a rejection with its reason", async () => {
    const written = await writePendingFixture();
    const rejected = await rejectPlan(written.ref.path, {
      reason: "Migration plan is missing",
      decidedAt: DECIDED_AT,
    });

    assert.equal(rejected.approval.status, "rejected");
    assert.equal(rejected.approval.reason, "Migration plan is missing");

    const reread = await readPlan(written.ref.path);
    assert.equal(reread.value.approval.status, "rejected");
  });

  it("normalizes a legacy plan to pending rather than approved", async () => {
    const legacyPlan = makePlan();
    const ref = await writeArtifact("plan", legacyPlan, {
      sessionId: SESSION_ID,
      createdAt: CREATED_AT,
    });

    const { value, legacy, warnings } = await readPlan(ref.path);

    assert.equal(legacy, true);
    assert.equal(value.approval.status, "pending");
    assert.equal(value.approval.decidedAt, undefined);
    assert.equal(value.schemaVersion, 2);
    assert.equal(value.revision, 1);
    assert.equal(value.sessionId, SESSION_ID);
    assert.equal(value.createdAt, CREATED_AT);
    assert.equal(value.approval.planHash, planHashOf(legacyPlan));
    // A legacy plan never recorded its intent, and kept the snapshot as prose.
    assert.equal(value.input.intent, "");
    assert.equal(value.input.snapshot.content, legacyPlan.snapshot);
    assert.deepEqual(value.plan, legacyPlan);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /legacy plan/i);
  });

  it("upgrades a legacy plan in place when it is approved", async () => {
    const legacyPlan = makePlan();
    const ref = await writeArtifact("plan", legacyPlan, {
      sessionId: SESSION_ID,
      createdAt: CREATED_AT,
    });

    await approvePlan(ref.path, { decidedAt: DECIDED_AT });

    const reread = await readPlan(ref.path);
    assert.equal(reread.legacy, false);
    assert.equal(reread.value.approval.status, "approved");
    assert.deepEqual(reread.value.plan, legacyPlan);

    // Callers that only want the plan body keep working across both versions.
    const { value } = await readArtifact("plan", ref.path);
    assert.deepEqual(value, legacyPlan);
  });

  it("supersedes the previous plan instead of inheriting its approval", async () => {
    const first = await writePendingFixture();
    await approvePlan(first.ref.path, { decidedAt: DECIDED_AT });

    const second = await writePendingPlan({
      sessionId: SESSION_ID,
      intent: "Prevent cross-tenant cache collisions",
      snapshot: makeSnapshot(),
      plan: makePlan({ summary: "Add a tenant salt and a migration step." }),
      createdAt: "2026-07-12T13:00:00.000Z",
    });

    assert.equal(second.ref.path, first.ref.path);
    assert.equal(second.value.revision, 2);
    assert.equal(second.value.planId, `${SESSION_ID}-r2`);
    assert.equal(second.value.supersedesPlanId, `${SESSION_ID}-r1`);
    assert.equal(second.value.approval.status, "pending");

    const current = await readPlan(first.ref.path);
    assert.equal(current.value.approval.status, "pending");
    assert.equal(current.value.revision, 2);

    assert.ok(second.supersededPath);
    const archived = await readPlan(second.supersededPath!);
    assert.equal(archived.value.planId, `${SESSION_ID}-r1`);
    assert.equal(archived.value.approval.status, "superseded");
  });

  it("treats an approval as stale when the plan body changed underneath it", async () => {
    const written = await writePendingFixture();
    await approvePlan(written.ref.path, { decidedAt: DECIDED_AT });

    const onDisk = JSON.parse(fs.readFileSync(written.ref.path, "utf8"));
    onDisk.plan.tasks[0].files.push("src/cache/store.ts");
    fs.writeFileSync(written.ref.path, JSON.stringify(onDisk, null, 2), "utf8");

    const { value, warnings } = await readPlan(written.ref.path);

    assert.equal(value.approval.status, "pending");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /planHash mismatch/i);
  });

  it("refuses to decide on a superseded plan", async () => {
    const first = await writePendingFixture();
    const second = await writePendingPlan({
      sessionId: SESSION_ID,
      intent: "Prevent cross-tenant cache collisions",
      snapshot: makeSnapshot(),
      plan: makePlan({ summary: "Revised." }),
      createdAt: "2026-07-12T13:00:00.000Z",
    });

    await assert.rejects(
      () => approvePlan(second.supersededPath!, { decidedAt: DECIDED_AT }),
      (err: unknown) => err instanceof SladError && err.code === "PLAN_APPROVAL_ERROR",
    );
    assert.ok(first.ref.path);
  });
});
