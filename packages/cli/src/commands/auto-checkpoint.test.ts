import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveAutoCheckpoint,
  loadAutoCheckpoint,
  clearAutoCheckpoint,
  type AutoCheckpoint,
} from "./auto-checkpoint.js";

describe("Auto pipeline checkpoints", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-checkpoint-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveAutoCheckpoint persiste el checkpoint a disco", () => {
    const cp: AutoCheckpoint = {
      intent: "añadir función sum al módulo math",
      sessionId: "2026-01-01-session-abc",
      lastStageCompleted: "explore",
      artifacts: { explore: "/path/to/explore.md" },
      budgetState: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01, byStage: {}, maxCostUsd: 1.0, maxTokens: 0 },
      savedAt: new Date().toISOString(),
    };

    saveAutoCheckpoint(cp, tmpDir);

    const checkpointFile = path.join(tmpDir, ".slad-os", "auto-checkpoint.json");
    assert.ok(fs.existsSync(checkpointFile), "el archivo de checkpoint debe existir");
    const loaded = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
    assert.equal(loaded.intent, cp.intent);
    assert.equal(loaded.sessionId, cp.sessionId);
    assert.equal(loaded.lastStageCompleted, "explore");
  });

  it("loadAutoCheckpoint retorna null si no existe checkpoint", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-empty-"));
    try {
      const cp = loadAutoCheckpoint(emptyDir);
      assert.equal(cp, null);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("loadAutoCheckpoint retorna el checkpoint guardado", () => {
    const cp: AutoCheckpoint = {
      intent: "refactorizar módulo auth",
      sessionId: "session-xyz",
      lastStageCompleted: "plan",
      artifacts: { explore: "/ex.md", snapshot: "/sn.md", plan: "/pl.md" },
      budgetState: { inputTokens: 500, outputTokens: 300, estimatedCostUsd: 0.05, byStage: {}, maxCostUsd: 1.0, maxTokens: 0 },
      savedAt: new Date().toISOString(),
    };

    saveAutoCheckpoint(cp, tmpDir);
    const loaded = loadAutoCheckpoint(tmpDir);

    assert.ok(loaded !== null, "debe retornar el checkpoint");
    assert.equal(loaded.intent, "refactorizar módulo auth");
    assert.equal(loaded.lastStageCompleted, "plan");
    assert.equal(loaded.sessionId, "session-xyz");
    assert.deepEqual(loaded.artifacts, cp.artifacts);
  });

  it("clearAutoCheckpoint elimina el archivo de checkpoint", () => {
    const cp: AutoCheckpoint = {
      intent: "test intent",
      sessionId: "s1",
      lastStageCompleted: "explore",
      artifacts: {},
      budgetState: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, byStage: {}, maxCostUsd: 0, maxTokens: 0 },
      savedAt: new Date().toISOString(),
    };
    saveAutoCheckpoint(cp, tmpDir);
    assert.ok(loadAutoCheckpoint(tmpDir) !== null, "checkpoint debe existir antes de clear");

    clearAutoCheckpoint(tmpDir);
    assert.equal(loadAutoCheckpoint(tmpDir), null, "checkpoint debe ser null después de clear");
  });

  it("saveAutoCheckpoint crea el directorio .slad-os si no existe", () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-fresh-"));
    try {
      const cp: AutoCheckpoint = {
        intent: "test",
        sessionId: "s1",
        lastStageCompleted: "explore",
        artifacts: {},
        budgetState: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, byStage: {}, maxCostUsd: 0, maxTokens: 0 },
        savedAt: new Date().toISOString(),
      };
      saveAutoCheckpoint(cp, freshDir);
      assert.ok(fs.existsSync(path.join(freshDir, ".slad-os", "auto-checkpoint.json")));
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
