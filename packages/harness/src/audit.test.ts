import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLogger, type AuditEvent } from "./audit.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slad-audit-test-"));
}

function makeEvent(taskId: string, kind: AuditEvent["kind"] = "task_start"): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
    taskId,
    kind,
    data: { title: `Task ${taskId}` },
  };
}

describe("AuditLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("crea el archivo de log si no existe", async () => {
    const logPath = path.join(tmpDir, "nested", "audit.ldjson");
    const logger = new AuditLogger(logPath);

    logger.log(makeEvent("T1"));
    await logger.flush();

    assert.ok(fs.existsSync(logPath));
  });

  it("escribe LDJSON válido (cada línea es JSON parseable)", async () => {
    const logPath = path.join(tmpDir, "audit.ldjson");
    const logger = new AuditLogger(logPath);

    logger.log(makeEvent("T1", "task_start"));
    logger.log(makeEvent("T1", "task_end"));
    await logger.flush();

    const lines = fs.readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean);

    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line); // should not throw
      assert.ok(parsed.taskId);
      assert.ok(parsed.timestamp);
      assert.ok(parsed.kind);
    }
  });

  it("es append-only — múltiples logs no sobreescriben", async () => {
    const logPath = path.join(tmpDir, "audit.ldjson");

    const logger1 = new AuditLogger(logPath);
    logger1.log(makeEvent("T1"));
    await logger1.flush();

    const logger2 = new AuditLogger(logPath);
    logger2.log(makeEvent("T2"));
    await logger2.flush();

    const lines = fs.readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean);

    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.taskId, "T1");
    assert.equal(second.taskId, "T2");
  });

  it("flush cierra el file descriptor", async () => {
    const logPath = path.join(tmpDir, "audit.ldjson");
    const logger = new AuditLogger(logPath);

    logger.log(makeEvent("T1"));
    await logger.flush();

    // After flush, calling flush again should be a no-op (fd is null)
    await logger.flush(); // should not throw
  });

  it("preserva todos los campos del AuditEvent", async () => {
    const logPath = path.join(tmpDir, "audit.ldjson");
    const logger = new AuditLogger(logPath);

    const event: AuditEvent = {
      timestamp: "2026-05-01T10:00:00.000Z",
      sessionId: "my-session",
      taskId: "T3",
      kind: "command_classified",
      data: { level: "full", reason: "sudo", original: "sudo rm -rf" },
    };

    logger.log(event);
    await logger.flush();

    const line = fs.readFileSync(logPath, "utf8").trim();
    const parsed = JSON.parse(line);

    assert.equal(parsed.timestamp, event.timestamp);
    assert.equal(parsed.sessionId, event.sessionId);
    assert.equal(parsed.taskId, event.taskId);
    assert.equal(parsed.kind, event.kind);
    assert.deepEqual(parsed.data, event.data);
  });
});
