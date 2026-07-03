import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LearnOutput, EvolveOutput } from "../core/types.js";
import {
  buildDecisionArgs,
  buildLearningArgs,
  globalMemoryScript,
  readProjectMemory,
  recordGlobalLearning,
} from "./global-memory.js";

function learnFixture(): LearnOutput {
  return {
    status: "completed",
    sourceRun: "session",
    taskId: "all",
    summary: "Aprendimos a paralelizar el run.",
    decisions: [],
    errors: ["stale sentinel resolvía workers al instante"],
    patterns: ["limpiar sentinels antes de spawn"],
    openQuestions: [],
    followUps: ["probar worktrees"],
    wikiEntryTitle: "Parallel run learnings",
    questions: [],
  };
}

describe("buildLearningArgs", () => {
  it("mapea LearnOutput a los flags de record-learning", () => {
    const args = buildLearningArgs(learnFixture(), { sessionId: "abc123" });
    assert.equal(args[args.indexOf("--title") + 1], "Parallel run learnings");
    assert.ok(args[args.indexOf("--context") + 1]!.includes("SLAD session abc123"));
    assert.equal(args[args.indexOf("--surprise") + 1], "stale sentinel resolvía workers al instante");
    assert.equal(args[args.indexOf("--pattern") + 1], "limpiar sentinels antes de spawn");
    assert.equal(args[args.indexOf("--follow-up") + 1], "probar worktrees");
  });
});

describe("buildDecisionArgs", () => {
  it("mapea EvolveOutput a los flags de record-decision", () => {
    const evolve = {
      status: "completed",
      title: "Ajustar prompt del planner",
      summary: "El planner necesita declarar files por tarea.",
      proposedUpdates: [
        { target: "prompts/planner.md", changeType: "update", content: "…", reason: "files vacíos" },
      ],
      nextActions: [],
      questions: [],
    } as unknown as EvolveOutput;

    const args = buildDecisionArgs(evolve, { sessionId: "abc123" });
    assert.equal(args[args.indexOf("--title") + 1], "Ajustar prompt del planner");
    assert.equal(args[args.indexOf("--status") + 1], "proposed");
    assert.equal(args[args.indexOf("--follow-up") + 1], "update prompts/planner.md");
  });
});

describe("readProjectMemory", () => {
  function projectsDirWith(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pm-"));
    fs.writeFileSync(path.join(dir, `${name}.md`), content);
    return dir;
  }

  it("lee la entrada que coincide con el basename del workspace", () => {
    const dir = projectsDirWith("slad", "# SLAD\n\nRuntime: .slad-os/.");
    assert.equal(readProjectMemory("/Users/chris/Projects/slad", dir), "# SLAD\n\nRuntime: .slad-os/.");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("retorna null cuando no hay entrada para el proyecto", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-pm-empty-"));
    assert.equal(readProjectMemory("/Users/chris/Projects/slad", dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("trunca entradas más largas que el máximo", () => {
    const dir = projectsDirWith("slad", "x".repeat(5_000));
    const result = readProjectMemory("/tmp/slad", dir);
    assert.ok(result!.length < 5_000);
    assert.ok(result!.endsWith("[…truncated]"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("respeta SLAD_GLOBAL_MEMORY=off", () => {
    const dir = projectsDirWith("slad", "contenido");
    process.env.SLAD_GLOBAL_MEMORY = "off";
    try {
      assert.equal(readProjectMemory("/tmp/slad", dir), null);
    } finally {
      delete process.env.SLAD_GLOBAL_MEMORY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recordGlobalLearning", () => {
  function stubScriptsDir(behavior: "ok" | "fail-once"): { dir: string; recordedTo: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-gm-"));
    const recordedTo = path.join(dir, "written.txt");
    const failFlag = path.join(dir, "failed-once");
    const script = [
      "const args = process.argv.slice(2);",
      "const title = args[args.indexOf('--title') + 1];",
      behavior === "fail-once"
        ? `if (!require('node:fs').existsSync(${JSON.stringify(failFlag)})) { require('node:fs').writeFileSync(${JSON.stringify(failFlag)}, ''); process.exit(1); }`
        : "",
      `require('node:fs').writeFileSync(${JSON.stringify(recordedTo)}, title);`,
      "console.log('/fake/learnings/' + title);",
    ].join("\n");
    // .mjs name is required by the bridge; CommonJS-style require via createRequire shim
    fs.writeFileSync(
      path.join(dir, "record-learning.mjs"),
      `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n${script}`,
    );
    return { dir, recordedTo };
  }

  it("retorna null cuando el script no existe", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "slad-gm-empty-"));
    assert.equal(globalMemoryScript("record-learning", empty), null);
    assert.equal(await recordGlobalLearning(learnFixture(), { sessionId: "abc" }, empty), null);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("invoca el script y retorna el path impreso", async () => {
    const { dir, recordedTo } = stubScriptsDir("ok");
    const result = await recordGlobalLearning(learnFixture(), { sessionId: "abc123" }, dir);
    assert.equal(result, "/fake/learnings/Parallel run learnings");
    assert.equal(fs.readFileSync(recordedTo, "utf8"), "Parallel run learnings");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reintenta con sufijo de sesión cuando el título colisiona", async () => {
    const { dir, recordedTo } = stubScriptsDir("fail-once");
    const result = await recordGlobalLearning(learnFixture(), { sessionId: "abc123" }, dir);
    assert.equal(result, "/fake/learnings/Parallel run learnings · abc123");
    assert.ok(fs.readFileSync(recordedTo, "utf8").includes("· abc123"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("respeta SLAD_GLOBAL_MEMORY=off", async () => {
    const { dir } = stubScriptsDir("ok");
    process.env.SLAD_GLOBAL_MEMORY = "off";
    try {
      assert.equal(await recordGlobalLearning(learnFixture(), { sessionId: "abc" }, dir), null);
    } finally {
      delete process.env.SLAD_GLOBAL_MEMORY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
