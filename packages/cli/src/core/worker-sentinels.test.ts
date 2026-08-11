import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  clearWorkerSentinels,
  inspectWorkers,
  isSessionTmuxWindow,
  removeWorkerSentinel,
  tmuxWindowName,
  workerGuardMessage,
  workerSentinelPath,
  writeWorkerSentinel,
} from "./worker-sentinels.js";

describe("tmux window namespacing (F9)", () => {
  it("el nombre generado contiene sessionId y taskId", () => {
    const name = tmuxWindowName("a1b2c3d4e5f6", "T1");
    assert.equal(name, "slad-a1b2c3d4e5f6-T1");
    assert.ok(name.includes("a1b2c3d4e5f6"));
    assert.ok(name.includes("T1"));
  });

  it("el filtro matchea las ventanas propias y no las de otra sesión", () => {
    assert.equal(isSessionTmuxWindow("slad-s1-T1", "s1"), true);
    assert.equal(isSessionTmuxWindow("slad-s1-T10", "s1"), true);
    assert.equal(isSessionTmuxWindow("slad-s2-T1", "s1"), false);
    // The pre-namespacing name and the bare prefix are not ours.
    assert.equal(isSessionTmuxWindow("slad-T1", "s1"), false);
    assert.equal(isSessionTmuxWindow("slad-s1-", "s1"), false);
    // A session id that merely starts with ours must not match.
    assert.equal(isSessionTmuxWindow("slad-s1extra-T1", "s1"), false);
  });
});

describe("worker sentinels (W2)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-sentinel-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("un pid inexistente del mismo host clasifica dead y se puede borrar", () => {
    writeWorkerSentinel(cwd, "s1", { runId: "run_a", taskId: "T1", pid: 2 ** 22, mode: "child" });

    const inspection = inspectWorkers(cwd, "s1");

    assert.equal(inspection.dead.length, 1);
    assert.equal(inspection.alive.length, 0);
    assert.equal(inspection.unknown.length, 0);
    clearWorkerSentinels(inspection.dead);
    assert.equal(fs.existsSync(workerSentinelPath(cwd, "s1", "T1")), false);
  });

  it("un proceso vivo clasifica alive y sigue vivo tras la inspección", async () => {
    // A real sleeping child: the assertion that matters is that inspecting it
    // never sends a signal — SLAD must never kill a pid read from disk.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    try {
      writeWorkerSentinel(cwd, "s2", { runId: "run_a", taskId: "T1", pid: child.pid!, mode: "child" });

      const inspection = inspectWorkers(cwd, "s2");

      assert.equal(inspection.alive.length, 1);
      assert.equal(inspection.alive[0]!.sentinel.pid, child.pid);
      assert.equal(child.killed, false);
      assert.equal(child.exitCode, null, "el worker vivo sigue vivo: no se le envió ninguna señal");
      assert.equal(fs.existsSync(workerSentinelPath(cwd, "s2", "T1")), true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("un sentinel de otro host clasifica unknown", () => {
    writeWorkerSentinel(cwd, "s3", { runId: "run_a", taskId: "T1", pid: 2 ** 22, mode: "child", host: "otra-maquina" });

    const inspection = inspectWorkers(cwd, "s3");

    assert.equal(inspection.unknown.length, 1);
    assert.equal(inspection.dead.length, 0);
  });

  it("un sentinel corrupto o ausente se ignora en vez de romper la inspección", () => {
    const dir = path.join(cwd, ".slad-os", "sessions", "s4", "tasks", "T1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "worker.json"), "{ no json", "utf8");
    fs.mkdirSync(path.join(cwd, ".slad-os", "sessions", "s4", "tasks", "T2"), { recursive: true });

    const inspection = inspectWorkers(cwd, "s4");

    assert.deepEqual([inspection.dead.length, inspection.alive.length, inspection.unknown.length], [0, 0, 0]);
  });

  it("el sentinel se borra al terminar normalmente", () => {
    writeWorkerSentinel(cwd, "s5", { runId: "run_a", taskId: "T1", pid: 2 ** 22, mode: "child" });
    removeWorkerSentinel(cwd, "s5", "T1");
    assert.equal(inspectWorkers(cwd, "s5").dead.length, 0);
  });

  it("el mensaje de rechazo trae pid, host y el comando de inspección", () => {
    writeWorkerSentinel(cwd, "s6", { runId: "run_a", taskId: "T2", pid: 4711, mode: "child", host: "otra-maquina" });
    const blocking = inspectWorkers(cwd, "s6").unknown;

    const message = workerGuardMessage("abortar el run r1", "s6", blocking);

    assert.ok(message.includes("T2"));
    assert.ok(message.includes("4711"));
    assert.ok(message.includes("otra-maquina"));
    assert.ok(message.includes("ps -p 4711"));
    assert.ok(message.includes("--assume-workers-dead"));
  });
});
