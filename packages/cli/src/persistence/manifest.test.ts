import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunManifest } from "@slad/shared";
import { createRunManifest, readRunManifest, updateRunManifest } from "./manifest.js";
import { ParseError } from "../core/errors.js";

describe("run manifest persistence", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "slad-manifest-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("creates a valid repo-local manifest atomically from starting to terminal", async () => {
    const handle = await createRunManifest({
      sessionId: "session-1",
      intent: "test manifest",
      command: "run-parallel",
      backend: { provider: "cli", agent: "pi", model: "openai-codex/gpt-5.5" },
      limits: { maxParallel: 2 },
      worktrees: { enabled: true, keep: false },
      tasks: [{ taskId: "T1", status: "pending" }],
    }, cwd);

    assert.equal(handle.value.status, "starting");
    assert.match(handle.path, /\.slad-os\/runs\/run_.+\/manifest\.json$/);
    await updateRunManifest(handle, { status: "completed", completedAt: new Date().toISOString() });

    const persisted = RunManifest.parse(JSON.parse(await readFile(handle.path, "utf8")));
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.traceId.length, 36);
  });

  it("marks running stages and tasks interrupted when resuming after a crash", async () => {
    const handle = await createRunManifest({
      sessionId: "session-1",
      intent: "crash test",
      command: "auto",
      backend: { provider: "cli" },
      limits: {},
      worktrees: { enabled: false, keep: false },
      stages: [{ id: "run", status: "running", startedAt: new Date().toISOString() }],
      tasks: [{ taskId: "T1", status: "running" }],
    }, cwd);
    await updateRunManifest(handle, { status: "running" });

    const recovered = await readRunManifest(handle.path, { markInterrupted: true });

    assert.equal(recovered.value.status, "interrupted");
    assert.equal(recovered.value.stages[0]?.status, "interrupted");
    assert.equal(recovered.value.tasks[0]?.status, "interrupted");
  });

  it("rejects corrupt manifests visibly", async () => {
    const manifestPath = path.join(cwd, "manifest.json");
    await writeFile(manifestPath, "{broken");

    await assert.rejects(
      () => readRunManifest(manifestPath),
      (error: unknown) => error instanceof ParseError && error.phase === "json",
    );
  });
});
