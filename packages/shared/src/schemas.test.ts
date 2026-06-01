import {
  SLASH_COMMAND_CATALOG,
  SlashCommand,
  SlashCommandArg,
  SlashCommandCatalog,
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

    for (const command of parsed) {
      assert.deepEqual(command.surfaces, ["cli", "ui"]);
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
