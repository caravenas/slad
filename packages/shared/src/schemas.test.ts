import {
  DoctorCheck,
  DoctorReport,
  DoctorStatus,
  PlanApprovalStatus,
  PlanArtifactEnvelope,
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
