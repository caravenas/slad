import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planHashOf, planInputDigestOf, readPlan } from "../persistence/index.js";
import { resetDocsRootCache } from "../persistence/layout.js";
import { createSession, getActiveSession, lastArtifactPath } from "../core/session.js";
import { planCommand } from "./plan.js";

const INTENT = "add sum function to math module";

function makeDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "slad.external-plan",
    schemaVersion: 1,
    intent: INTENT,
    snapshot: { content: "# Snapshot\n\nAdd sum()." },
    plan: {
      snapshot: "Add sum().",
      summary: "One task.",
      tasks: [
        {
          id: "T1",
          title: "Implement sum()",
          description: "Add sum() to src/math.ts",
          type: "implementation",
          priority: "high",
          files: ["src/math.ts"],
          acceptanceCriteria: ["sum works"],
        },
      ],
      recommendedFirstTask: "T1",
    },
    source: { producer: "external-planner" },
    ...overrides,
  };
}

describe("plan --import wiring", () => {
  const originalCwd = process.cwd();
  const originalDocsPath = process.env.SLAD_DOCS_PATH;
  const originalDefaultAgent = process.env.SLAD_DEFAULT_AGENT;
  const originalExitCode = process.exitCode;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "slad-plan-import-wiring-"));
    dir = fs.realpathSync(dir);
    process.env.SLAD_DOCS_PATH = path.join(dir, "docs");
    // Poison the legacy generation path: if --import ever fell through to
    // provider resolution, AgentName.parse would throw and fail the test.
    process.env.SLAD_DEFAULT_AGENT = "not-a-real-agent";
    resetDocsRootCache();
    process.chdir(dir);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalDocsPath === undefined) delete process.env.SLAD_DOCS_PATH;
    else process.env.SLAD_DOCS_PATH = originalDocsPath;
    if (originalDefaultAgent === undefined) delete process.env.SLAD_DEFAULT_AGENT;
    else process.env.SLAD_DEFAULT_AGENT = originalDefaultAgent;
    resetDocsRootCache();
    process.exitCode = originalExitCode;
    await rm(dir, { recursive: true, force: true });
  });

  function writeDocument(overrides: Record<string, unknown> = {}): string {
    const filePath = path.join(dir, "external-plan.json");
    fs.writeFileSync(filePath, JSON.stringify(makeDocument(overrides), null, 2), "utf8");
    return filePath;
  }

  function plansDir(): string {
    return path.join(dir, "docs", "log", "plans");
  }

  function assertNothingPersisted(): void {
    assert.equal(fs.existsSync(plansDir()), false);
    const session = getActiveSession();
    if (session) {
      assert.equal(lastArtifactPath(session, "plan"), undefined);
    }
  }

  // ─── Flag conflicts ────────────────────────────────────────────────────────

  it("exits 1 when --import is combined with --check, --approve or --reject", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument();

    for (const conflicting of [{ check: true }, { approve: true }, { reject: true }]) {
      process.exitCode = undefined;
      await planCommand({ import: filePath, ...conflicting });
      assert.equal(process.exitCode, 1);
    }
    assertNothingPersisted();
  });

  it("exits 1 when --import is combined with --skip-session", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument();

    await planCommand({ import: filePath, skipSession: true });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("exits 1 without an active session", async () => {
    const filePath = writeDocument();

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  // ─── Successful import ─────────────────────────────────────────────────────

  it("persists a pending plan bound to the session and appends the artifact", async () => {
    const session = createSession(INTENT, dir);
    const filePath = writeDocument();

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, undefined);
    const updated = getActiveSession();
    assert.ok(updated);
    const planPath = lastArtifactPath(updated, "plan");
    assert.ok(planPath, "session must record the imported plan artifact");

    const stored = await readPlan(planPath);
    assert.equal(stored.legacy, false);
    assert.equal(stored.value.sessionId, session.id);
    assert.equal(stored.value.revision, 1);
    assert.equal(stored.value.approval.status, "pending");
    assert.equal(stored.value.input.intent, INTENT);
  });

  it("keeps the SLAD-owned hash and digest stable after import", async () => {
    const session = createSession(INTENT, dir);
    const filePath = writeDocument();

    await planCommand({ import: filePath });

    const planPath = lastArtifactPath(getActiveSession()!, "plan")!;
    const first = await readPlan(planPath);
    const second = await readPlan(planPath);

    assert.equal(first.value.approval.planHash, planHashOf(first.value.plan));
    assert.equal(
      first.value.input.digest,
      planInputDigestOf(session.intent, first.value.input.snapshot),
    );
    assert.equal(second.value.approval.planHash, first.value.approval.planHash);
    assert.equal(second.value.input.digest, first.value.input.digest);
    assert.deepEqual(second.staleApproval, undefined);
  });

  it("re-importing supersedes the previous plan with the next revision", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument();

    await planCommand({ import: filePath });
    const firstPath = lastArtifactPath(getActiveSession()!, "plan")!;
    const first = await readPlan(firstPath);

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, undefined);
    const secondPath = lastArtifactPath(getActiveSession()!, "plan")!;
    const second = await readPlan(secondPath);
    assert.equal(second.value.revision, 2);
    assert.equal(second.value.supersedesPlanId, first.value.planId);
    assert.equal(second.value.approval.status, "pending");

    const archived = fs.readdirSync(plansDir()).filter((entry) => entry.endsWith(".json"));
    const supersededFile = archived
      .map((entry) => JSON.parse(fs.readFileSync(path.join(plansDir(), entry), "utf8")) as {
        planId: string;
        approval: { status: string };
      })
      .find((envelope) => envelope.planId === first.value.planId);
    assert.equal(supersededFile?.approval.status, "superseded");
  });

  it("--json prints a summary of the imported plan", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument();

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await planCommand({ import: filePath, json: true });
    } finally {
      console.log = original;
    }

    assert.equal(process.exitCode, undefined);
    const parsed = JSON.parse(lines.join("\n")) as {
      planPath: string;
      revision: number;
      approval: string;
    };
    assert.equal(parsed.approval, "pending");
    assert.equal(parsed.revision, 1);
    assert.ok(parsed.planPath.length > 0);
  });

  // ─── Failures never persist ────────────────────────────────────────────────

  it("exits 1 on a missing file", async () => {
    createSession(INTENT, dir);

    await planCommand({ import: path.join(dir, "missing.json") });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("exits 1 on invalid JSON without persisting", async () => {
    createSession(INTENT, dir);
    const filePath = path.join(dir, "broken.json");
    fs.writeFileSync(filePath, "{not json", "utf8");

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("exits 1 on a schema violation without persisting", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument({ kind: "plan" });

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("exits 1 on an external envelope field without persisting", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument({ approval: { status: "approved", planHash: "x" } });

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("exits 1 on an intent mismatch without persisting", async () => {
    createSession(INTENT, dir);
    const filePath = writeDocument({ intent: "a different intent" });

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("exits 1 on preflight blockers without persisting", async () => {
    createSession(INTENT, dir);
    const base = makeDocument();
    const plan = base.plan as { tasks: { files: string[] }[] };
    plan.tasks[0]!.files = ["/etc/passwd"];
    const filePath = path.join(dir, "external-plan.json");
    fs.writeFileSync(filePath, JSON.stringify(base), "utf8");

    await planCommand({ import: filePath });

    assert.equal(process.exitCode, 1);
    assertNothingPersisted();
  });

  it("a failed re-import leaves the previous imported plan untouched", async () => {
    createSession(INTENT, dir);
    await planCommand({ import: writeDocument() });
    const planPath = lastArtifactPath(getActiveSession()!, "plan")!;
    const before = fs.readFileSync(planPath, "utf8");

    await planCommand({ import: writeDocument({ intent: "a different intent" }) });

    assert.equal(process.exitCode, 1);
    assert.equal(fs.readFileSync(planPath, "utf8"), before);
    const stored = await readPlan(planPath);
    assert.equal(stored.value.revision, 1);
  });
});
