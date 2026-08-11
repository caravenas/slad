import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  acquireSessionLock,
  inspectLockHolder,
  releaseSessionLock,
  sessionLockPath,
} from "./session-lock.js";

describe("session lock", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-lock-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  /** Writes a holder record directly, standing in for another process. */
  function plantHolder(sessionId: string, holder: Record<string, unknown>): void {
    const lockPath = sessionLockPath(cwd, sessionId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(holder), "utf8");
  }

  it("de dos adquisiciones concurrentes gana exactamente una", () => {
    const first = acquireSessionLock(cwd, "s1", { runId: "run_a", command: "run" });
    const second = acquireSessionLock(cwd, "s1", { runId: "run_b", command: "resume" });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(inspectLockHolder(cwd, "s1")?.runId, "run_a");
  });

  it("un tenedor vivo del mismo host rechaza y nombra al proceso", () => {
    plantHolder("s2", {
      v: 1, epoch: 1, runId: "run_live", pid: process.pid, host: os.hostname(),
      user: "someone", startedAt: "2026-08-11T00:00:00.000Z", command: "run",
    });

    const result = acquireSessionLock(cwd, "s2", { runId: "run_new", command: "resume" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("run_live"));
    assert.ok(!result.ok && result.reason.includes(`ps -p ${process.pid}`));
    assert.equal(inspectLockHolder(cwd, "s2")?.runId, "run_live");
  });

  it("un pid inexistente del mismo host permite el takeover por época", () => {
    plantHolder("s3", {
      v: 1, epoch: 4, runId: "run_dead", pid: 2 ** 22, host: os.hostname(),
      user: "someone", startedAt: "2026-08-11T00:00:00.000Z", command: "run",
    });

    const result = acquireSessionLock(cwd, "s3", { runId: "run_new", command: "resume" });

    assert.equal(result.ok, true);
    const holder = inspectLockHolder(cwd, "s3");
    assert.equal(holder?.runId, "run_new");
    assert.equal(holder?.epoch, 5, "el takeover avanza la época en vez de unlink + open");
    assert.equal(fs.existsSync(`${sessionLockPath(cwd, "s3")}.5`), false, "el staging se renombra, no queda");
  });

  it("del mismo lock stale, exactamente un tomador gana la época", () => {
    plantHolder("s4", {
      v: 1, epoch: 1, runId: "run_dead", pid: 2 ** 22, host: os.hostname(),
      user: "someone", startedAt: "2026-08-11T00:00:00.000Z", command: "run",
    });
    // Simulates the loser of the O_EXCL race on the next epoch.
    fs.writeFileSync(`${sessionLockPath(cwd, "s4")}.2`, "{}", "utf8");

    const result = acquireSessionLock(cwd, "s4", { runId: "run_new", command: "resume" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("en este mismo instante"));
  });

  it("un tenedor de otro host rechaza aunque el pid no exista acá", () => {
    plantHolder("s5", {
      v: 1, epoch: 1, runId: "run_remote", pid: 2 ** 22, host: "otra-maquina",
      user: "someone", startedAt: "2026-08-11T00:00:00.000Z", command: "run",
    });

    const result = acquireSessionLock(cwd, "s5", { runId: "run_new", command: "resume" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("otra-maquina"));
  });

  it("un lock ilegible rechaza en vez de asumir que nadie lo tiene", () => {
    const lockPath = sessionLockPath(cwd, "s6");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "no json", "utf8");

    const result = acquireSessionLock(cwd, "s6", { runId: "run_new", command: "run" });

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("ilegible"));
  });

  it("si el lock se está terminando de escribir, reintenta y nombra al tenedor", async () => {
    const lockPath = sessionLockPath(cwd, "s6b");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "", "utf8");

    const writer = path.join(cwd, "finish-lock.js");
    const readyPath = path.join(cwd, "writer.ready");
    const triggerPath = path.join(cwd, "writer.go");
    fs.writeFileSync(writer, [
      "const fs = require('node:fs');",
      "const { Atomics, Int32Array, SharedArrayBuffer } = globalThis;",
      "const [lockPath, readyPath, triggerPath] = process.argv.slice(2);",
      "fs.writeFileSync(readyPath, 'ready', 'utf8');",
      "while (!fs.existsSync(triggerPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);",
      `fs.writeFileSync(lockPath, JSON.stringify({ v: 1, epoch: 1, runId: 'run_live', pid: process.ppid, host: ${JSON.stringify(os.hostname())}, user: 'someone', startedAt: '2026-08-11T00:00:00.000Z', command: 'run' }), 'utf8');`,
    ].join("\n"), "utf8");
    const child = spawn(process.execPath, [writer, lockPath, readyPath, triggerPath], { stdio: "ignore" });
    while (!fs.existsSync(readyPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    fs.writeFileSync(triggerPath, "go", "utf8");

    const result = acquireSessionLock(cwd, "s6b", { runId: "run_new", command: "run" });
    await once(child, "exit");

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("run_live"));
  });

  it("--force-unlock exige el runId exacto del tenedor", () => {
    plantHolder("s7", {
      v: 1, epoch: 1, runId: "run_live", pid: process.pid, host: os.hostname(),
      user: "someone", startedAt: "2026-08-11T00:00:00.000Z", command: "run",
    });

    assert.equal(acquireSessionLock(cwd, "s7", { runId: "n", command: "run", forceUnlock: "otro" }).ok, false);
    assert.equal(acquireSessionLock(cwd, "s7", { runId: "n", command: "run", forceUnlock: "run_live" }).ok, true);
  });

  it("release solo borra el lock propio", () => {
    const mine = acquireSessionLock(cwd, "s8", { runId: "run_a", command: "run" });
    assert.ok(mine.ok);
    // Another taker replaced it after our epoch.
    plantHolder("s8", {
      v: 1, epoch: 9, runId: "run_other", pid: process.pid, host: os.hostname(),
      user: "someone", startedAt: "2026-08-11T00:00:00.000Z", command: "resume",
    });

    releaseSessionLock(mine.lock);

    assert.equal(inspectLockHolder(cwd, "s8")?.runId, "run_other");
  });

  it("release es idempotente y deja la sesión libre", () => {
    const result = acquireSessionLock(cwd, "s9", { runId: "run_a", command: "run" });
    assert.ok(result.ok);
    releaseSessionLock(result.lock);
    releaseSessionLock(result.lock);
    assert.equal(fs.existsSync(sessionLockPath(cwd, "s9")), false);
    assert.equal(acquireSessionLock(cwd, "s9", { runId: "run_b", command: "run" }).ok, true);
  });
});
