import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExternalPlanDocument } from "@slad/shared";
import { planHashOf, planInputDigestOf } from "../persistence/index.js";
import {
  evaluateExternalPlan,
  importExternalPlanFromFile,
  parseExternalPlanDocument,
  type PlanImportSession,
} from "./plan-import.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION: PlanImportSession = { id: "s1", intent: "add sum function" };

function makeDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "slad.external-plan",
    schemaVersion: 1,
    intent: "add sum function",
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
    ...overrides,
  };
}

function parseDocument(overrides: Record<string, unknown> = {}): ExternalPlanDocument {
  const parsed = parseExternalPlanDocument(JSON.stringify(makeDocument(overrides)));
  assert.ok(parsed.ok, "fixture document must parse");
  return parsed.document;
}

// ─── parseExternalPlanDocument ───────────────────────────────────────────────

describe("parseExternalPlanDocument", () => {
  it("parses a canonical document", () => {
    const result = parseExternalPlanDocument(JSON.stringify(makeDocument()));

    assert.ok(result.ok);
    assert.equal(result.document.intent, "add sum function");
    assert.equal(result.document.plan.tasks.length, 1);
  });

  it("fails with a json error on invalid JSON", () => {
    const result = parseExternalPlanDocument("{not json");

    assert.ok(!result.ok);
    assert.equal(result.error.code, "json");
  });

  it("fails with schema issues on a wrong kind", () => {
    const result = parseExternalPlanDocument(JSON.stringify(makeDocument({ kind: "plan" })));

    assert.ok(!result.ok);
    assert.equal(result.error.code, "schema");
    assert.ok(result.error.issues.some((issue) => issue.startsWith("kind")));
  });

  it("rejects external envelope fields such as approval or digest", () => {
    const result = parseExternalPlanDocument(
      JSON.stringify(makeDocument({ approval: { status: "approved", planHash: "x" } })),
    );

    assert.ok(!result.ok);
    assert.equal(result.error.code, "schema");
  });

  it("rejects envelope fields smuggled into nested objects", () => {
    const base = makeDocument() as {
      snapshot: Record<string, unknown>;
      plan: { tasks: Array<Record<string, unknown>> } & Record<string, unknown>;
    };
    const nested: Array<{ path: string; document: Record<string, unknown> }> = [
      {
        path: "snapshot",
        document: { ...base, snapshot: { ...base.snapshot, digest: "abc" } },
      },
      {
        path: "plan",
        document: { ...base, plan: { ...base.plan, approval: { status: "approved" } } },
      },
      {
        path: "plan.tasks.0",
        document: {
          ...base,
          plan: { ...base.plan, tasks: [{ ...base.plan.tasks[0], planHash: "abc" }] },
        },
      },
    ];

    for (const { path, document } of nested) {
      const result = parseExternalPlanDocument(JSON.stringify(document));

      assert.ok(!result.ok, `unknown field under ${path} must be rejected`);
      assert.equal(result.error.code, "schema");
      if (result.error.code === "schema") {
        assert.ok(
          result.error.issues.some((issue) => issue.startsWith(path)),
          `issue must point at ${path}`,
        );
      }
    }
  });
});

// ─── evaluateExternalPlan ────────────────────────────────────────────────────

describe("evaluateExternalPlan", () => {
  it("accepts a matching intent and a preflight-clean plan", () => {
    const result = evaluateExternalPlan(parseDocument(), SESSION);

    assert.ok(result.ok);
    assert.equal(result.gate.ok, true);
    assert.deepEqual(result.gate.blockers, []);
  });

  it("matches the intent trim-insensitively", () => {
    const document = parseDocument({ intent: "  add sum function \n" });
    const result = evaluateExternalPlan(document, SESSION);

    assert.ok(result.ok);
  });

  it("fails on an intent mismatch", () => {
    const document = parseDocument({ intent: "another intent" });
    const result = evaluateExternalPlan(document, SESSION);

    assert.ok(!result.ok);
    assert.equal(result.error.code, "intent-mismatch");
  });

  it("fails preflight on duplicate task ids without persisting anything", () => {
    const base = makeDocument();
    const plan = base.plan as { tasks: unknown[] };
    plan.tasks = [...plan.tasks, ...plan.tasks];
    const document = parseDocument({ plan });
    const result = evaluateExternalPlan(document, SESSION);

    assert.ok(!result.ok);
    assert.equal(result.error.code, "preflight");
    assert.ok(result.error.gate.blockers.some((issue) => issue.code === "task.id.duplicate"));
  });

  it("fails preflight on an absolute declared file path", () => {
    const base = makeDocument();
    const plan = base.plan as { tasks: { files: string[] }[] };
    plan.tasks[0]!.files = ["/etc/passwd"];
    const document = parseDocument({ plan });
    const result = evaluateExternalPlan(document, SESSION);

    assert.ok(!result.ok);
    assert.equal(result.error.code, "preflight");
    assert.ok(result.error.gate.blockers.some((issue) => issue.code === "task.files.absolute"));
  });

  it("fails preflight when the plan status is not completed", () => {
    const base = makeDocument();
    (base.plan as Record<string, unknown>).status = "awaiting_human";
    const document = parseDocument({ plan: base.plan });
    const result = evaluateExternalPlan(document, SESSION);

    assert.ok(!result.ok);
    assert.equal(result.error.code, "preflight");
    assert.ok(result.error.gate.blockers.some((issue) => issue.code === "plan.status.not-completed"));
  });

  it("builds the candidate digest and hash from the session intent, not the document intent", () => {
    const document = parseDocument({ intent: "  add sum function  " });
    const result = evaluateExternalPlan(document, SESSION);

    assert.ok(result.ok);
    // The persisted envelope will carry exactly these values (SLAD-owned).
    assert.equal(planHashOf(document.plan), planHashOf(result.document.plan));
    assert.equal(
      planInputDigestOf(SESSION.intent, document.snapshot),
      planInputDigestOf(SESSION.intent, result.document.snapshot),
    );
  });
});

// ─── importExternalPlanFromFile ──────────────────────────────────────────────

describe("importExternalPlanFromFile", () => {
  it("fails with a read error when the file does not exist", async () => {
    const result = await importExternalPlanFromFile("/nonexistent/plan.json", SESSION);

    assert.ok(!result.ok);
    assert.equal(result.error.code, "read");
  });

  it("reads and validates a document from disk", async () => {
    const dir = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), "slad-plan-import-")));
    try {
      const filePath = path.join(dir, "external-plan.json");
      await writeFile(filePath, JSON.stringify(makeDocument()), "utf8");

      const result = await importExternalPlanFromFile(filePath, SESSION);

      assert.ok(result.ok);
      assert.equal(result.document.plan.recommendedFirstTask, "T1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
