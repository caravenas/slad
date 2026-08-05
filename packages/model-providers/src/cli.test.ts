import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { launchSpecFromEnv, runCli } from "./cli.js";

describe("LaunchSpec", { concurrency: false }, () => {
  it("constructs arg-mode ordering and workspace substitution once", () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      SLAD_CLI_BINARY: "agy",
      SLAD_CLI_ARGS: "--add-dir {workspace} --print",
      SLAD_CLI_PROMPT_MODE: "arg",
      SLAD_CLI_MODEL_ARG: "--model",
      CLI_MODEL: "Gemini 3.5 Flash (Low)",
    });
    try {
      const spec = launchSpecFromEnv({ prompt: "do work", workspace: "/tmp/workspace" });
      assert.equal(spec.binary, "agy");
      assert.deepEqual(spec.args, [
        "--model", "Gemini 3.5 Flash (Low)", "--add-dir", "/tmp/workspace", "--print", "do work",
      ]);
      assert.equal(spec.stdin, undefined);
    } finally {
      process.env = previous;
    }
  });
});

describe("CLI subprocess lifecycle", () => {
  it("times out a hanging process", async () => {
    const started = Date.now();
    await assert.rejects(
      () => runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 50,
        killGraceMs: 50,
      }),
      /timeout/,
    );
    assert.ok(Date.now() - started < 2_000);
  });

  it("cancels through AbortSignal", async () => {
    const controller = new AbortController();
    const result = runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      killGraceMs: 50,
    });
    setTimeout(() => controller.abort(), 30);

    await assert.rejects(() => result, /cancelled/);
  });

  it("closes stdin so arg-mode processes waiting for EOF can complete", async () => {
    const output = await runCli(process.execPath, ["-e", "process.stdin.on('end', () => console.log('closed')); process.stdin.resume()"]);
    assert.equal(output, "closed");
  });
});
