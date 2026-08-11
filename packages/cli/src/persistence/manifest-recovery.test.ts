import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createRunManifest,
  interruptStaleRunManifests,
  isTerminalRunStatus,
  listSessionRunManifests,
  markRunInterrupted,
  markRunUnrecoverable,
  readRunManifest,
  updateRunManifest,
} from "./manifest.js";

describe("U5 — marcadores de clase A / clase B", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-recovery-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function runningManifest(runId: string, sessionId = "s1", withIntegration = true) {
    const manifest = await createRunManifest({
      runId,
      sessionId,
      intent: "test",
      command: "run-parallel",
      backend: { provider: "cli" },
      tasks: [{ taskId: "T1", status: "running" }],
      limits: { maxTasks: 10 },
      worktrees: {
        enabled: true,
        keep: false,
        ...(withIntegration
          ? { integration: { branch: `slad/${sessionId}/integration`, baseRef: "a".repeat(40), tip: "b".repeat(40) } }
          : {}),
      },
    }, cwd);
    await updateRunManifest(manifest, { status: "running" });
    return manifest;
  }

  it("markRunInterrupted deja recovery.safe true y reason signal", async () => {
    const manifest = await runningManifest("run_a");

    await markRunInterrupted(manifest, { signal: "SIGINT", hasIntegration: true });

    const { value } = await readRunManifest(manifest.path);
    assert.equal(value.status, "interrupted");
    assert.deepEqual(value.recovery, { safe: true, reason: "signal", signal: "SIGINT" });
    assert.equal(value.tasks[0]!.status, "interrupted", "las tareas running vuelven a la mesa");
    assert.ok(value.completedAt);
  });

  it("sin integración, una señal deja el run cancelled y sin marcador de recuperabilidad", async () => {
    const manifest = await runningManifest("run_b", "s1", false);

    await markRunInterrupted(manifest, { signal: "SIGTERM", hasIntegration: false });

    const { value } = await readRunManifest(manifest.path);
    assert.equal(value.status, "cancelled");
    assert.equal(value.recovery, undefined);
  });

  it("interruptStaleRunManifests deja safe false y reason uncaught", async () => {
    const manifest = await runningManifest("run_c");

    const interrupted = await interruptStaleRunManifests("s1", cwd);

    assert.equal(interrupted.length, 1);
    const { value } = await readRunManifest(manifest.path);
    assert.equal(value.status, "interrupted");
    assert.deepEqual(value.recovery, { safe: false, reason: "uncaught" });
  });

  it("markRunUnrecoverable nunca marca safe, aunque el corte venga del proceso vivo", async () => {
    const manifest = await runningManifest("run_d");

    await markRunUnrecoverable(manifest, "no se pudo persistir el checkpoint de T1: disco lleno");

    const { value } = await readRunManifest(manifest.path);
    assert.equal(value.status, "interrupted");
    assert.deepEqual(value.recovery, { safe: false, reason: "uncaught" });
    assert.ok(value.terminalReason?.includes("disco lleno"));
  });

  it("un interrupted sin recovery (manifest anterior al cambio) no es seguro", async () => {
    const manifest = await runningManifest("run_e");
    await updateRunManifest(manifest, { status: "interrupted" });

    const { value } = await readRunManifest(manifest.path);
    assert.equal(value.recovery, undefined, "la ausencia falla hacia el lado seguro");
  });

  it("el terminalReason se acota para no inflar el manifest", async () => {
    const manifest = await runningManifest("run_f");

    await markRunUnrecoverable(manifest, "x".repeat(2000));

    assert.equal((await readRunManifest(manifest.path)).value.terminalReason?.length, 400);
  });
});

describe("listSessionRunManifests / isTerminalRunStatus", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-manifests-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("filtra por sesión y ordena del más nuevo al más viejo", async () => {
    for (const [runId, sessionId] of [["run_1", "sA"], ["run_2", "sB"], ["run_3", "sA"]]) {
      await createRunManifest({
        runId, sessionId: sessionId!, intent: "t", command: "run",
        backend: { provider: "cli" }, limits: {}, worktrees: { enabled: false, keep: false },
      }, cwd);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const handles = await listSessionRunManifests("sA", cwd);

    assert.deepEqual(handles.map((handle) => handle.value.runId), ["run_3", "run_1"]);
  });

  it("review_pending e interrupted no son terminales; applied y aborted sí", () => {
    assert.equal(isTerminalRunStatus("review_pending"), false);
    assert.equal(isTerminalRunStatus("interrupted"), false);
    assert.equal(isTerminalRunStatus("running"), false);
    assert.equal(isTerminalRunStatus("applied"), true);
    assert.equal(isTerminalRunStatus("aborted"), true);
    assert.equal(isTerminalRunStatus("cancelled"), true);
    assert.equal(isTerminalRunStatus("completed"), true);
  });
});
