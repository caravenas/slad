import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listSessions, loadSession } from "./session.js";

function writeSessionEnvelope(cwd: string, sessionId: string, archivedAt?: string): void {
  const sessionsDir = path.join(cwd, "docs", "log", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const session = {
    id: sessionId,
    createdAt: "2026-05-01T10:00:00.000Z",
    ...(archivedAt ? { archivedAt } : {}),
    intent: "compat test",
    artifacts: [],
    humanAnswers: [],
    notes: [],
  };

  const envelope = {
    kind: "session",
    schemaVersion: 1,
    sessionId,
    createdAt: session.createdAt,
    value: session,
  };

  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(envelope, null, 2), "utf8");
}

function withLocalDocsEnv(run: () => void): void {
  const prev = process.env.SLAD_DOCS_PATH;
  delete process.env.SLAD_DOCS_PATH;
  try {
    run();
  } finally {
    if (prev === undefined) {
      delete process.env.SLAD_DOCS_PATH;
    } else {
      process.env.SLAD_DOCS_PATH = prev;
    }
  }
}

test("CLI session parser accepts sessions with optional archivedAt", () => {
  withLocalDocsEnv(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-session-compat-"));
    try {
      const sessionId = "s-archived";
      const archivedAt = "2026-05-10T12:00:00.000Z";
      writeSessionEnvelope(cwd, sessionId, archivedAt);

      const loaded = loadSession(sessionId, cwd);
      assert.ok(loaded);
      assert.equal(loaded?.id, sessionId);
      assert.equal(loaded?.archivedAt, archivedAt);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("CLI listSessions keeps archived sessions visible by default", () => {
  withLocalDocsEnv(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-session-list-compat-"));
    try {
      writeSessionEnvelope(cwd, "s-active");
      writeSessionEnvelope(cwd, "s-archived", "2026-05-10T12:00:00.000Z");

      const sessions = listSessions(cwd);
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id).sort(),
        ["s-active", "s-archived"],
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
