import {
  DoctorCheck,
  DoctorReport,
  DoctorStatus,
  EXTERNAL_PLAN_KIND,
  ExternalPlanDocument,
  PlanApprovalStatus,
  PlanArtifactEnvelope,
  RunManifest,
  RunManifestStatus,
  RunOutput,
  SLASH_COMMAND_CATALOG,
  SlashCommand,
  SlashCommandArg,
  SlashCommandCatalog,
  SnapshotOutput,
  renderSlashCommandSignature,
  type SlashCommand as SlashCommandType,
} from "./schemas.js";

// @ts-ignore @slad/shared does not take a direct @types/node dependency.
const { describe, it } = await import("node:test");
// @ts-ignore @slad/shared does not take a direct @types/node dependency.
const { default: assert } = await import("node:assert/strict");

const validCommand: SlashCommandType = {
  id: "test",
  title: "Test",
  description: "Run a test command.",
  category: "meta",
  surfaces: ["cli", "ui"],
  args: [],
  executionIntent: {
    kind: "dual",
    emitsSessionMessage: true,
    invokesLocalAction: true,
    localAction: "test.run",
  },
  aliases: [],
  visibility: {
    hidden: false,
    experimental: false,
    enabledByDefault: true,
  },
  permission: {
    permissions: [],
    risk: "low",
  },
  config: {
    requiresActiveSession: false,
    requiresWorkspaceTrust: false,
    requiresProvider: false,
    requiresPlan: false,
  },
  metadata: {
    keywords: [],
  },
};

describe("SlashCommand", () => {
  it("validates the canonical slash command catalog", () => {
    const parsed = SlashCommandCatalog.parse(SLASH_COMMAND_CATALOG);
    const ids = new Set(parsed.map((command) => command.id));

    assert.equal(ids.size, parsed.length);
    assert.ok(ids.has("ask"));
    assert.ok(ids.has("auto"));
    assert.ok(ids.has("chat"));
    assert.ok(ids.has("explore"));
    assert.ok(ids.has("snapshot"));
    assert.ok(ids.has("plan"));
    assert.ok(ids.has("run"));
    assert.ok(ids.has("learn"));
    assert.ok(ids.has("evolve"));
    assert.ok(ids.has("stats"));
    assert.ok(ids.has("version"));
    assert.ok(ids.has("status"));
    assert.ok(ids.has("new"));
    assert.ok(ids.has("help"));
    assert.ok(ids.has("exit"));

    // The command family shares a uniform shape: dual intent and no args
    // (always available on the CLI surface). Surfaces may be cli-only (e.g. `model`).
    for (const command of parsed) {
      assert.ok(command.surfaces.includes("cli"));
      assert.ok(command.surfaces.every((surface) => surface === "cli" || surface === "ui"));
      assert.deepEqual(command.args, []);
      assert.equal(command.executionIntent.kind, "dual");
      assert.equal(command.executionIntent.emitsSessionMessage, true);
      assert.equal(command.executionIntent.invokesLocalAction, true);
    }
  });

  it("accepts valid slash command definitions", () => {
    const parsed = SlashCommand.parse(validCommand);

    assert.equal(parsed.id, "test");
    assert.deepEqual(parsed.surfaces, ["cli", "ui"]);
    assert.equal(parsed.executionIntent.localAction, "test.run");
  });

  it("rejects invalid surfaces", () => {
    const result = SlashCommand.safeParse({
      ...validCommand,
      surfaces: ["cli", "mobile"],
    });

    assert.equal(result.success, false);
  });

  it("supports all initial argument kinds", () => {
    const args = [
      { type: "string", name: "query", label: "Query", description: "Free text." },
      {
        type: "enum",
        name: "mode",
        label: "Mode",
        description: "Select one mode.",
        options: [{ value: "fast", label: "Fast" }],
      },
      { type: "boolean", name: "force", label: "Force", description: "Force execution." },
      { type: "path", name: "targetPath", label: "Path", description: "File or directory path." },
      { type: "project", name: "project", label: "Project", description: "Project selector." },
      { type: "confirm", name: "confirm", label: "Confirm", description: "Confirm before running." },
    ];

    for (const arg of args) {
      assert.equal(SlashCommandArg.safeParse(arg).success, true, `${arg.type} arg should parse`);
    }
  });

  it("rejects malformed args", () => {
    const result = SlashCommandArg.safeParse({
      type: "enum",
      name: "mode",
      label: "Mode",
      description: "Select one mode.",
      options: [],
    });

    assert.equal(result.success, false);
  });

  it("renders signatures with required and optional arguments", () => {
    const command = SlashCommand.parse({
      ...validCommand,
      id: "deploy",
      title: "Deploy",
      args: [
        {
          type: "string",
          name: "target",
          label: "Target",
          description: "Deployment target.",
          required: true,
          placeholder: "target",
        },
        {
          type: "boolean",
          name: "force",
          label: "Force",
          description: "Skip confirmation.",
          required: false,
          placeholder: "--force",
        },
      ],
    });

    assert.equal(renderSlashCommandSignature(command), "/deploy <target> [--force]");
    assert.equal(
      renderSlashCommandSignature({
        name: "deploy",
        description: "Run deployment.",
        arguments: [
          { name: "target", placeholder: "target", optional: false },
          { name: "force", placeholder: "--force", optional: true },
        ],
      }),
      "/deploy <target> [--force]",
    );
  });

  it("covers hidden, experimental, permission and config flags", () => {
    const parsed = SlashCommand.parse({
      ...validCommand,
      visibility: {
        hidden: true,
        experimental: true,
        enabledByDefault: false,
      },
      permission: {
        permissions: ["workspace:write", "process:exec"],
        risk: "high",
      },
      config: {
        requiresActiveSession: true,
        requiresWorkspaceTrust: true,
        requiresProvider: true,
        requiresPlan: true,
      },
    });

    assert.equal(parsed.visibility.hidden, true);
    assert.equal(parsed.visibility.experimental, true);
    assert.equal(parsed.visibility.enabledByDefault, false);
    assert.deepEqual(parsed.permission.permissions, ["workspace:write", "process:exec"]);
    assert.equal(parsed.permission.risk, "high");
    assert.equal(parsed.config.requiresActiveSession, true);
    assert.equal(parsed.config.requiresWorkspaceTrust, true);
    assert.equal(parsed.config.requiresProvider, true);
    assert.equal(parsed.config.requiresPlan, true);
  });
});

describe("Doctor contract", () => {
  const healthyCheck = {
    name: "git",
    status: "healthy",
    message: "Git is available.",
    blocking: false,
  };

  it("accepts only the canonical doctor statuses", () => {
    assert.deepEqual(DoctorStatus.options, ["healthy", "warning", "blocked"]);
    assert.equal(DoctorStatus.safeParse("healthy").success, true);
    assert.equal(DoctorStatus.safeParse("warning").success, true);
    assert.equal(DoctorStatus.safeParse("blocked").success, true);
    assert.equal(DoctorStatus.safeParse("failed").success, false);
  });

  it("requires the core doctor check fields and accepts optional evidence", () => {
    const parsed = DoctorCheck.parse({
      ...healthyCheck,
      evidence: ["git version 2.50.1"],
      recommendation: "Install git if this check fails.",
    });

    assert.equal(parsed.name, "git");
    assert.equal(parsed.status, "healthy");
    assert.deepEqual(parsed.evidence, ["git version 2.50.1"]);
    assert.equal(parsed.recommendation, "Install git if this check fails.");

    for (const field of ["name", "status", "message", "blocking"] as const) {
      const invalid: Record<string, unknown> = { ...healthyCheck };
      delete invalid[field];

      assert.equal(DoctorCheck.safeParse(invalid).success, false, `${field} should be required`);
    }
  });

  it("validates reports with matching summary aggregation and overall status", () => {
    const parsed = DoctorReport.parse({
      status: "blocked",
      summary: {
        passed: 1,
        warnings: 1,
        blockers: 1,
      },
      checks: [
        healthyCheck,
        {
          name: "tmux",
          status: "warning",
          message: "tmux is not installed; child-process fallback will be used.",
          blocking: false,
        },
        {
          name: "workspace",
          status: "blocked",
          message: "Workspace is not writable.",
          blocking: true,
        },
      ],
    });

    assert.equal(parsed.summary.passed, 1);
    assert.equal(parsed.summary.warnings, 1);
    assert.equal(parsed.summary.blockers, 1);
    assert.equal(parsed.status, "blocked");
  });

  it("rejects reports with invalid summary counts or aggregate status", () => {
    assert.equal(
      DoctorReport.safeParse({
        status: "healthy",
        summary: {
          passed: 1,
          warnings: 0,
          blockers: 0,
        },
        checks: [
          healthyCheck,
          {
            name: "tmux",
            status: "warning",
            message: "tmux is not installed; child-process fallback will be used.",
            blocking: false,
          },
        ],
      }).success,
      false,
    );

    assert.equal(
      DoctorReport.safeParse({
        status: "warning",
        summary: {
          passed: 1,
          warnings: 1,
          blockers: 0,
        },
        checks: [healthyCheck],
      }).success,
      false,
    );
  });
});

describe("PlanArtifactEnvelope", () => {
  const envelope = {
    kind: "plan",
    schemaVersion: 2,
    planId: "plan-2",
    sessionId: "session-1",
    revision: 1,
    createdAt: "2026-07-12T12:00:00.000Z",
    approval: {
      status: "pending",
      planHash: "sha256:abc123",
    },
    input: {
      intent: "Add plan approval metadata.",
      snapshot: { content: "Current state." },
      digest: "snapshot-digest",
    },
    plan: {
      snapshot: "Current state.",
      summary: "Add the shared plan envelope.",
    },
  };

  it("parses the versioned plan artifact envelope", () => {
    const parsed = PlanArtifactEnvelope.parse(envelope);

    assert.equal(parsed.kind, "plan");
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.approval.status, "pending");
    assert.deepEqual(parsed.input.snapshot.assumptions, []);
  });

  it("supports every approval state", () => {
    for (const status of PlanApprovalStatus.options) {
      const parsed = PlanArtifactEnvelope.parse({
        ...envelope,
        approval: {
          ...envelope.approval,
          status,
          ...(status === "approved" ? { decidedAt: "2026-07-12T12:01:00.000Z" } : {}),
        },
      });

      assert.equal(parsed.approval.status, status);
    }
  });

  it("defaults snapshot and run assumptions to empty arrays", () => {
    assert.deepEqual(SnapshotOutput.parse({}).assumptions, []);
    assert.deepEqual(
      RunOutput.parse({ taskId: "T1", status: "completed", summary: "Done." }).assumptions,
      [],
    );
  });
});

describe("ExternalPlanDocument", () => {
  const document = {
    kind: "slad.external-plan",
    schemaVersion: 1,
    intent: "add sum function to math module",
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
  };

  it("parses a canonical external plan and applies nested defaults", () => {
    const parsed = ExternalPlanDocument.parse(document);

    assert.equal(parsed.kind, EXTERNAL_PLAN_KIND);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.snapshot.status, "completed");
    assert.deepEqual(parsed.plan.tasks[0]?.dependsOn, []);
    assert.equal(parsed.source, undefined);
  });

  it("accepts an optional source with producer and datetime createdAt", () => {
    const parsed = ExternalPlanDocument.parse({
      ...document,
      source: { producer: "pi", createdAt: "2026-08-09T10:00:00.000Z" },
    });

    assert.equal(parsed.source?.producer, "pi");
  });

  it("rejects a wrong kind or schemaVersion", () => {
    assert.equal(ExternalPlanDocument.safeParse({ ...document, kind: "plan" }).success, false);
    assert.equal(ExternalPlanDocument.safeParse({ ...document, schemaVersion: 2 }).success, false);
  });

  it("rejects a blank intent", () => {
    assert.equal(ExternalPlanDocument.safeParse({ ...document, intent: "" }).success, false);
    assert.equal(ExternalPlanDocument.safeParse({ ...document, intent: "   " }).success, false);
  });

  it("rejects external envelope fields: no approval, digest or hash may enter", () => {
    for (const extra of [
      { approval: { status: "approved", planHash: "x" } },
      { digest: "abc" },
      { planHash: "abc" },
      { planId: "external-id" },
    ]) {
      assert.equal(ExternalPlanDocument.safeParse({ ...document, ...extra }).success, false);
    }
  });

  const deepDocument = {
    ...document,
    snapshot: {
      content: "# Snapshot\n\nAdd sum().",
      assumptions: ["repo builds"],
      questions: [{ id: "q1", prompt: "Which module?", kind: "free" }],
    },
    plan: {
      ...document.plan,
      questions: [{ id: "q2", prompt: "Ship it?", kind: "confirm" }],
      decisions: [
        {
          id: "d1",
          stage: "plan",
          decision: "Use a single task",
          alternatives: [{ option: "split in two", rejectedBecause: "overkill" }],
          evidence: [{ kind: "snapshot", ref: "snap-1" }],
          reversibility: "trivial",
        },
      ],
    },
    source: { producer: "pi" },
  };

  it("parses a document with nested questions and decisions, applying defaults", () => {
    const parsed = ExternalPlanDocument.parse(deepDocument);

    assert.equal(parsed.snapshot.questions[0]?.blocking, true);
    assert.equal(parsed.plan.decisions[0]?.rationale, "");
    assert.deepEqual(parsed.plan.decisions[0]?.supersedes, []);
  });

  it("rejects unknown fields at every nested depth", () => {
    const mutations: Array<{ path: string; mutate: (doc: any) => void }> = [
      { path: "snapshot", mutate: (doc) => { doc.snapshot.digest = "abc"; } },
      { path: "snapshot.questions.0", mutate: (doc) => { doc.snapshot.questions[0].planHash = "abc"; } },
      { path: "plan", mutate: (doc) => { doc.plan.approval = { status: "approved", planHash: "abc" }; } },
      { path: "plan.tasks.0", mutate: (doc) => { doc.plan.tasks[0].planHash = "abc"; } },
      { path: "plan.questions.0", mutate: (doc) => { doc.plan.questions[0].digest = "abc"; } },
      { path: "plan.decisions.0", mutate: (doc) => { doc.plan.decisions[0].approval = "approved"; } },
      { path: "plan.decisions.0.alternatives.0", mutate: (doc) => { doc.plan.decisions[0].alternatives[0].digest = "abc"; } },
      { path: "plan.decisions.0.evidence.0", mutate: (doc) => { doc.plan.decisions[0].evidence[0].planHash = "abc"; } },
    ];

    for (const { path, mutate } of mutations) {
      const doc = JSON.parse(JSON.stringify(deepDocument));
      mutate(doc);
      const result = ExternalPlanDocument.safeParse(doc);
      assert.equal(result.success, false, `unknown field under ${path} must be rejected`);
      const issues = result.success ? [] : result.error.issues;
      assert.ok(
        issues.some((issue) => issue.path.join(".") === path),
        `issue must point at ${path}`,
      );
    }
  });

  it("rejects unknown keys inside source", () => {
    const result = ExternalPlanDocument.safeParse({
      ...document,
      source: { producer: "pi", planHash: "abc" },
    });
    assert.equal(result.success, false);
  });

  it("rejects a non-datetime source.createdAt", () => {
    const result = ExternalPlanDocument.safeParse({
      ...document,
      source: { producer: "pi", createdAt: "yesterday" },
    });
    assert.equal(result.success, false);
  });
});

describe("RunManifest — review before apply", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const baseManifest = {
    schemaVersion: 1,
    runId: "run_x",
    traceId: "3f0e6f14-9c1d-4b06-9a53-0e6a1c2d3e4f",
    sessionId: "s1",
    intent: "test",
    command: "run-parallel",
    status: "review_pending",
    backend: { provider: "cli" },
    startedAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };

  it("accepts the review-before-apply statuses", () => {
    assert.equal(RunManifestStatus.parse("review_pending"), "review_pending");
    assert.equal(RunManifestStatus.parse("applied"), "applied");
    assert.equal(RunManifestStatus.parse("aborted"), "aborted");
  });

  it("parses integration metadata with follow-up linkage", () => {
    const parsed = RunManifest.parse({
      ...baseManifest,
      worktrees: {
        enabled: true,
        integration: {
          branch: "slad/s1/integration",
          baseRef: SHA_A,
          tip: SHA_B,
          fromRun: "run_parent",
        },
      },
    });
    assert.equal(parsed.status, "review_pending");
    assert.equal(parsed.worktrees.integration?.tip, SHA_B);
    assert.equal(parsed.worktrees.integration?.fromRun, "run_parent");
  });

  it("keeps integration optional and defaults worktrees when absent", () => {
    const parsed = RunManifest.parse({ ...baseManifest, status: "completed" });
    assert.deepEqual(parsed.worktrees, { enabled: false, keep: false });
  });

  it("rejects integration metadata missing its branch or refs", () => {
    for (const missing of ["branch", "baseRef", "tip"] as const) {
      const integration: Record<string, string> = {
        branch: "slad/s1/integration",
        baseRef: SHA_A,
        tip: SHA_B,
      };
      delete integration[missing];
      const result = RunManifest.safeParse({
        ...baseManifest,
        worktrees: { enabled: true, integration },
      });
      assert.equal(result.success, false, `integration.${missing} must be required`);
    }
  });
});
