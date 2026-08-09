import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRunManifest, readRunManifest, updateRunManifest } from "../persistence/manifest.js";
import { abortRunAction, applyRunAction } from "./run.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function branchExists(cwd: string, branch: string): boolean {
  return spawnSync("git", ["-C", cwd, "rev-parse", "--verify", `refs/heads/${branch}`], { stdio: "ignore" }).status === 0;
}

describe("run review actions", () => {
  let cwd: string;
  let baseBranch: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), "slad-run-review-"));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "test@example.com");
    git(cwd, "config", "user.name", "Test");
    writeFileSync(path.join(cwd, "README.md"), "base\n");
    writeFileSync(path.join(cwd, ".gitignore"), ".slad-os/\n");
    git(cwd, "add", "README.md", ".gitignore");
    git(cwd, "commit", "-q", "-m", "base");
    baseBranch = git(cwd, "branch", "--show-current");
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    rmSync(cwd, { recursive: true, force: true });
  });

  async function pendingRun(sessionId: string, runId: string) {
    const baseRef = git(cwd, "rev-parse", "HEAD");
    const branch = `slad/${sessionId}/integration`;
    git(cwd, "checkout", "-q", "-b", branch);
    writeFileSync(path.join(cwd, `${runId}.txt`), `${runId}\n`);
    git(cwd, "add", `${runId}.txt`);
    git(cwd, "commit", "-q", "-m", runId);
    const tip = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "-q", baseBranch);
    const manifest = await createRunManifest({
      runId,
      sessionId,
      intent: "review",
      command: "run-parallel",
      backend: { provider: "cli" },
      limits: {},
      worktrees: { enabled: true, keep: false, integration: { branch, baseRef, tip } },
    }, cwd);
    await updateRunManifest(manifest, { status: "review_pending" });
    return { branch, manifestPath: manifest.path, tip };
  }

  it("apply stages one squash and marks the run applied", async () => {
    const { branch, manifestPath } = await pendingRun("s1", "run_apply");

    await applyRunAction("run_apply", cwd);

    assert.equal(process.exitCode, undefined);
    assert.equal(git(cwd, "diff", "--cached", "--name-only"), "run_apply.txt");
    assert.equal(branchExists(cwd, branch), false);
    assert.equal((await readRunManifest(manifestPath)).value.status, "applied");
  });

  it("abort deletes integration refs without touching main and marks aborted", async () => {
    const { branch, manifestPath } = await pendingRun("s2", "run_abort");

    await abortRunAction("run_abort", cwd);

    assert.equal(process.exitCode, undefined);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    assert.equal(branchExists(cwd, branch), false);
    assert.equal((await readRunManifest(manifestPath)).value.status, "aborted");
  });

  it("abort refuses a stale parent whose integration branch moved", async () => {
    const { branch, manifestPath } = await pendingRun("s3", "run_parent");
    git(cwd, "checkout", "-q", branch);
    writeFileSync(path.join(cwd, "child.txt"), "child\n");
    git(cwd, "add", "child.txt");
    git(cwd, "commit", "-q", "-m", "child");
    git(cwd, "checkout", "-q", baseBranch);

    await abortRunAction("run_parent", cwd);

    assert.equal(process.exitCode, 1);
    assert.equal(branchExists(cwd, branch), true);
    assert.equal((await readRunManifest(manifestPath)).value.status, "review_pending");
  });

  it("apply limpia un squash conflictivo y conserva el run review_pending", async () => {
    const branch = "slad/s4/integration";
    git(cwd, "checkout", "-q", "-b", branch);
    writeFileSync(path.join(cwd, "README.md"), "integration\n");
    git(cwd, "add", "README.md");
    git(cwd, "commit", "-q", "-m", "integration");
    const tip = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "-q", baseBranch);
    writeFileSync(path.join(cwd, "README.md"), "main\n");
    git(cwd, "add", "README.md");
    git(cwd, "commit", "-q", "-m", "main");
    const mainHead = git(cwd, "rev-parse", "HEAD");
    const manifest = await createRunManifest({
      runId: "run_conflict",
      sessionId: "s4",
      intent: "review",
      command: "run-parallel",
      backend: { provider: "cli" },
      limits: {},
      worktrees: { enabled: true, keep: false, integration: { branch, baseRef: mainHead, tip } },
    }, cwd);
    await updateRunManifest(manifest, { status: "review_pending" });

    await applyRunAction("run_conflict", cwd);

    assert.equal(process.exitCode, 1);
    assert.equal(git(cwd, "rev-parse", "HEAD"), mainHead);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    assert.equal(readFileSync(path.join(cwd, "README.md"), "utf8"), "main\n");
    assert.equal(branchExists(cwd, branch), true);
    assert.equal((await readRunManifest(manifest.path)).value.status, "review_pending");
  });
});
