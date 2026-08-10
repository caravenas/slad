import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LifecycleHookError, loadLifecycleHooks, runPostLifecycleHooks, runPreLifecycleHooks } from "./lifecycle-hooks.js";
import { PlanOutput, RunOutput, type PlanTask } from "./types.js";

describe("lifecycle hooks", () => {
  const originalEnv = { ...process.env };
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-hooks-"));
    process.env.HOME = cwd;
    process.env.SLAD_WORKSPACE = cwd;
    process.env.SLAD_LOG_LEVEL = "silent";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function writeConfig(root: string, value: unknown): void {
    const dir = path.join(root, ".slad-os");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(value), "utf8");
  }

  function writeGlobalConfig(value: unknown): void {
    const dir = path.join(cwd, ".slad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(value), "utf8");
  }

  function writeHook(name: string, source: string): string {
    const file = path.join(cwd, name);
    fs.writeFileSync(file, source, "utf8");
    return `./${name}`;
  }

  const task: PlanTask = {
    id: "T1",
    title: "Task",
    description: "Do it",
    type: "implementation",
    priority: "high",
    dependsOn: [],
    files: ["src/a.ts"],
    acceptanceCriteria: ["done"],
  };

  const plan = PlanOutput.parse({
    snapshot: "snapshot",
    summary: "summary",
    tasks: [task],
    recommendedFirstTask: "T1",
  });

  const output = RunOutput.parse({
    taskId: "T1",
    status: "completed",
    summary: "done",
  });

  it("is disabled by default and project config overrides global config", () => {
    assert.deepEqual(loadLifecycleHooks(cwd).preRun, []);

    const globalHook = writeHook("global.mjs", "export default () => ({ allow: true });");
    const projectHook = writeHook("project.mjs", "export default () => ({ allow: true });");
    writeGlobalConfig({ lifecycleHooks: { preRun: [globalHook] } });
    writeConfig(cwd, { lifecycleHooks: { preRun: [projectHook], postRun: ["./post.mjs"] } });

    assert.deepEqual(loadLifecycleHooks(path.join(cwd, "no-config")).preRun, [globalHook]);
    assert.deepEqual(loadLifecycleHooks(cwd).preRun, [projectHook]);
    assert.deepEqual(loadLifecycleHooks(cwd).postRun, ["./post.mjs"]);
  });

  it("fails closed when a pre hook denies or cannot load", async () => {
    const deny = writeHook("deny.mjs", "export default () => ({ allow: false, reason: 'blocked' });");
    const hooks = { ...loadLifecycleHooks(cwd), preRun: [deny] };

    await assert.rejects(
      () => runPreLifecycleHooks(hooks, "pre-run", {
        event: "pre-run",
        command: "run",
        cwd,
        sessionId: "s1",
        intent: "intent",
        plan,
      }),
      LifecycleHookError,
    );

    await assert.rejects(
      () => runPreLifecycleHooks({ ...hooks, preRun: ["./missing.mjs"] }, "pre-run", {
        event: "pre-run",
        command: "run",
        cwd,
        sessionId: "s1",
        intent: "intent",
        plan,
      }),
      LifecycleHookError,
    );
  });

  it("post hook failures warn only and cannot mutate the original output", async () => {
    const mutate = writeHook(
      "mutate.mjs",
      "export default (ctx) => { ctx.output.changedFiles.push('bad.ts'); throw new Error('ignored'); };",
    );

    await runPostLifecycleHooks({ ...loadLifecycleHooks(cwd), postTask: [mutate] }, "post-task", {
      event: "post-task",
      command: "run",
      cwd,
      sessionId: "s1",
      task,
      output,
    });

    assert.deepEqual(output.changedFiles, []);
  });
});
