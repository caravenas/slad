import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { serializeBackendSelectionToConfigPatch } from "./backend-registry.js";
import { writeGlobalConfigPatch } from "./config.js";

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
});
