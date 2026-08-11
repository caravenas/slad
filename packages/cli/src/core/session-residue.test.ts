import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRunManifest, updateRunManifest } from "../persistence/manifest.js";
import { collectSessionResidue, formatResidueRefusal, hasResidue } from "./session-residue.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("U10 — A2: el residuo de la sesión bloquea un run fresco", () => {
  let cwd: string;
  let baseRef: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-residue-"));
    git(cwd, "init", "-q");
    fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".slad-os/\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    baseRef = git(cwd, "rev-parse", "HEAD");
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function manifest(
    runId: string,
    sessionId: string,
    status: Parameters<typeof updateRunManifest>[1] extends never ? never : "review_pending" | "interrupted" | "running" | "applied" | "aborted",
    integration?: { branch: string; baseRef: string; tip: string },
    tasks: { taskId: string; status: "completed" | "pending" }[] = [],
  ) {
    const handle = await createRunManifest({
      runId,
      sessionId,
      intent: "t",
      command: "run-parallel",
      backend: { provider: "cli" },
      tasks,
      limits: {},
      worktrees: { enabled: true, keep: false, ...(integration ? { integration } : {}) },
    }, cwd);
    await updateRunManifest(handle, { status });
    return handle;
  }

  it("(a) solo una ref huérfana de tarea, con el tip de integración en su baseRef", async () => {
    await manifest("run_a", "sa", "applied", { branch: "slad/sa/integration", baseRef, tip: baseRef });
    git(cwd, "branch", "slad/sa/integration", baseRef);
    git(cwd, "branch", "slad/sa/T1", baseRef);

    const residue = await collectSessionResidue(cwd, "sa");

    assert.equal(hasResidue(residue), true);
    assert.deepEqual(residue.items.map((item) => item.kind), ["ref"]);
    assert.equal((residue.items[0] as { branch: string }).branch, "slad/sa/T1");
    assert.equal(residue.unattributed.length, 1, "sin manifest dueño: SLAD solo imprime el comando");
    assert.ok(formatResidueRefusal("sa", residue).includes("git branch -D slad/sa/T1"));
    // Nothing was auto-cleaned.
    assert.ok(git(cwd, "for-each-ref", "refs/heads/slad/sa/", "--format=%(refname)").includes("T1"));
  });

  it("(b) solo un worktree registrado bajo el root de la sesión, sin refs de tarea", async () => {
    await manifest("run_b", "sb", "applied");
    const worktreeDir = path.join(cwd, ".slad-os", "sessions", "sb", "worktrees", "T1");
    git(cwd, "worktree", "add", "-q", "-B", "keep-me", worktreeDir, "HEAD");

    const residue = await collectSessionResidue(cwd, "sb");

    assert.equal(hasResidue(residue), true);
    assert.ok(residue.items.some((item) => item.kind === "worktree"));
    assert.ok(formatResidueRefusal("sb", residue).includes("git worktree remove --force"));
    assert.ok(fs.existsSync(path.join(worktreeDir, ".git")), "el worktree sigue existiendo");
    git(cwd, "worktree", "remove", "--force", worktreeDir);
  });

  it("(c) solo un manifest no terminal, sin ninguna ref", async () => {
    const handle = await manifest("run_c", "sc", "running");

    const residue = await collectSessionResidue(cwd, "sc");

    assert.equal(hasResidue(residue), true);
    assert.deepEqual(residue.items, [{ kind: "manifest", runId: "run_c", status: "running" }]);
    assert.ok(fs.existsSync(handle.path), "el manifest sigue existiendo");
  });

  it("caso positivo: manifest terminal + ref de integración inerte en su baseRef ⇒ procede", async () => {
    await manifest("run_d", "sd", "applied", { branch: "slad/sd/integration", baseRef, tip: baseRef });
    git(cwd, "branch", "slad/sd/integration", baseRef);

    const residue = await collectSessionResidue(cwd, "sd");

    assert.equal(hasResidue(residue), false);
  });

  it("una ref de integración con trabajo por encima de su baseRef no es inerte", async () => {
    git(cwd, "branch", "slad/se/integration", baseRef);
    git(cwd, "worktree", "add", "-q", "--detach", path.join(cwd, "wt"), baseRef);
    fs.writeFileSync(path.join(cwd, "wt", "x.txt"), "x\n");
    git(path.join(cwd, "wt"), "add", "-A");
    git(path.join(cwd, "wt"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "work");
    const tip = git(path.join(cwd, "wt"), "rev-parse", "HEAD");
    git(cwd, "branch", "-f", "slad/se/integration", tip);
    git(cwd, "worktree", "remove", "--force", path.join(cwd, "wt"));
    await manifest("run_e", "se", "applied", { branch: "slad/se/integration", baseRef, tip: baseRef });

    const residue = await collectSessionResidue(cwd, "se");

    assert.equal(hasResidue(residue), true);
  });

  it("una ref de tarea no mergeada se reporta como tal, por alcanzabilidad", async () => {
    const worktreeDir = path.join(cwd, "wt2");
    git(cwd, "worktree", "add", "-q", "-B", "slad/sf/T1", worktreeDir, baseRef);
    fs.writeFileSync(path.join(worktreeDir, "t1.txt"), "t1\n");
    git(worktreeDir, "add", "-A");
    git(worktreeDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t1");
    git(cwd, "worktree", "remove", "--force", worktreeDir);
    git(cwd, "branch", "slad/sf/integration", baseRef);
    await manifest(
      "run_f", "sf", "interrupted",
      { branch: "slad/sf/integration", baseRef, tip: baseRef },
      [{ taskId: "T1", status: "pending" }],
    );

    const residue = await collectSessionResidue(cwd, "sf");

    const taskRef = residue.items.find((item) => item.kind === "ref" && item.branch === "slad/sf/T1");
    assert.ok(taskRef && taskRef.kind === "ref");
    assert.equal(taskRef.merged, false);
    assert.equal(taskRef.runId, "run_f", "la ref es atribuible al manifest que declara T1");
    assert.equal(residue.unattributed.length, 0);
    const message = formatResidueRefusal("sf", residue);
    assert.ok(message.includes("ref no mergeada"));
    assert.ok(message.includes("--abort  run_f"));
  });
});
