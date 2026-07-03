import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { serializeBackendSelectionToConfigPatch } from "./backend-registry.js";
import { resolveProvider, writeGlobalConfigPatch } from "./config.js";

describe("config", () => {
  it("mergea patches en el config global sin borrar claves existentes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-config-"));
    const configPath = path.join(tmpDir, "config.json");

    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ providers: { apiKeyEnv: { anthropic: "ANTHROPIC_API_KEY" } } }),
        "utf8",
      );

      const codexPath = path.join(tmpDir, "codex");
      const result = writeGlobalConfigPatch(
        serializeBackendSelectionToConfigPatch(
          { provider: "codex", model: "gpt-5-codex" },
          {
            input: codexPath,
            resolvedPath: codexPath,
            status: "resolved",
            explicitPath: true,
          },
        ),
        configPath,
      );

      assert.deepEqual(result, {
        providers: {
          apiKeyEnv: { anthropic: "ANTHROPIC_API_KEY" },
          defaultProvider: "cli",
          defaultAgent: "codex",
          models: { cli: "gpt-5-codex" },
          agentModels: { codex: "gpt-5-codex" },
          binaries: { codex: codexPath },
        },
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), result);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-detecta el primer backend disponible en PATH cuando no hay agente configurado", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-autodetect-"));
    const savedKeys = [
      "PATH", "HOME", "SLAD_WORKSPACE", "SLAD_CLI_BINARY", "SLAD_CLI_ARGS",
      "SLAD_CLI_PROMPT_MODE", "SLAD_CLI_MODEL_ARG", "SLAD_DEFAULT_AGENT",
      "SLAD_DEFAULT_PROVIDER", "SLAD_CLI_INHERIT_API_KEYS", "CLI_MODEL",
    ];
    const saved = Object.fromEntries(savedKeys.map((k) => [k, process.env[k]]));

    try {
      // PATH contains only a fake `pi`; claude (preferred) is absent, so
      // detection must fall through to pi.
      const piPath = path.join(tmpDir, "pi");
      fs.writeFileSync(piPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(piPath, 0o755);

      process.env.PATH = tmpDir;
      process.env.HOME = tmpDir;
      process.env.SLAD_WORKSPACE = tmpDir;
      for (const k of savedKeys.slice(3)) delete process.env[k];

      const provider = resolveProvider(undefined, undefined, "cli", undefined);

      assert.equal(provider, "cli");
      assert.equal(process.env.SLAD_DEFAULT_AGENT, "pi");
      assert.equal(process.env.SLAD_CLI_BINARY, piPath);
      assert.equal(process.env.SLAD_CLI_ARGS, "--print --no-session");
      assert.equal(process.env.SLAD_CLI_PROMPT_MODE, "arg");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
