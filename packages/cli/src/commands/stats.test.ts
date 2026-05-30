import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionError } from "../core/errors.js";
import { saveSession } from "../core/session.js";
import type { SessionState } from "../core/types.js";
import { statsCommand } from "./stats.js";
import { resetDocsRootCache } from "../persistence/layout.js";

const originalDocsPath = process.env.SLAD_DOCS_PATH;

test.beforeEach(() => {
  delete process.env.SLAD_DOCS_PATH;
  resetDocsRootCache();
});

test.afterEach(() => {
  if (originalDocsPath === undefined) {
    delete process.env.SLAD_DOCS_PATH;
  } else {
    process.env.SLAD_DOCS_PATH = originalDocsPath;
  }
  resetDocsRootCache();
});

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slad-stats-command-"));
}

function session(id: string, artifactKinds: SessionState["artifacts"][number]["kind"][]): SessionState {
  return {
    id,
    createdAt: "2026-05-06T00:00:00.000Z",
    intent: `Intent ${id}`,
    artifacts: artifactKinds.map((kind, index) => ({
      kind,
      path: `sessions/${id}/artifacts/${index}.json`,
      createdAt: "2026-05-06T00:00:00.000Z",
    })),
    humanAnswers: [],
    notes: [],
  };
}

function makeWriter(): { write(s: string): void; value(): string } {
  let buf = "";
  return {
    write(s: string) { buf += s; },
    value() { return buf; },
  };
}

test("stats --json prints parseable numeric totals from isolated sessions", { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const project = makeTempProject();

  try {
    process.chdir(project);
    process.env["SLAD_DOCS_PATH"] = path.join(project, "docs");
    resetDocsRootCache();
    saveSession(session("s1", ["run", "learn", "snapshot"]));
    saveSession(session("s2", ["plan", "run", "learn"]));

    const writer = makeWriter();
    await statsCommand({ json: true }, writer);
    const parsed = JSON.parse(writer.value()) as Record<string, unknown>;

    assert.deepEqual(Object.keys(parsed).sort(), ["budget", "learnings", "runs", "sessions", "telemetry"]);
    assert.equal(parsed.sessions, 2);
    assert.equal(parsed.runs, 2);
    assert.equal(parsed.learnings, 2);
    assert.equal(typeof parsed.sessions, "number");
    assert.equal(typeof parsed.runs, "number");
    assert.equal(typeof parsed.learnings, "number");
    assert.equal(typeof parsed.budget, "object");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("stats prints human-readable Sessions, Runs, and Learnings totals", { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const project = makeTempProject();

  try {
    process.chdir(project);
    process.env["SLAD_DOCS_PATH"] = path.join(project, "docs");
    resetDocsRootCache();
    saveSession(session("s1", ["run", "learn"]));

    const writer = makeWriter();
    await statsCommand({}, writer);

    assert.match(writer.value(), /Sessions:/);
    assert.match(writer.value(), /Runs:/);
    assert.match(writer.value(), /Learnings:/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("stats fails explicitly when a persisted session is corrupt", { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const project = makeTempProject();

  try {
    process.chdir(project);
    process.env["SLAD_DOCS_PATH"] = path.join(project, "docs");
    resetDocsRootCache();
    const corruptStatePath = path.join(project, "docs", "log", "sessions", "corrupt.json");
    fs.mkdirSync(path.dirname(corruptStatePath), { recursive: true });
    fs.writeFileSync(corruptStatePath, JSON.stringify({ kind: "session", schemaVersion: 1, value: { id: "bad", invalid: true } }), "utf8");

    const writer = makeWriter();
    await assert.rejects(() => statsCommand({ json: true }, writer), (err: unknown) => {
      assert.equal(err instanceof SessionError, true);
      assert.match((err as Error).message, /estado inválido/);
      return true;
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});
