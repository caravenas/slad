import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generate, toKebab, toPascal } from "./create.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// commands → src → cli → packages → repo root
const repoRoot = path.resolve(here, "../../../..");
const blueprintsDir = path.join(repoRoot, "blueprints");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slad-create-"));
}

test("toKebab / toPascal", () => {
  assert.equal(toKebab("MyCoolAgent"), "my-cool-agent");
  assert.equal(toKebab("fetchIssues"), "fetch-issues");
  assert.equal(toPascal("my-cool-agent"), "MyCoolAgent");
});

test("create agent scaffolds a minimal project with substituted placeholders", () => {
  const cwd = tmpDir();
  const res = generate("agent", "demo", { cwd, blueprintsDir });

  assert.equal(res.template, "basic-agent");
  assert.equal(res.destination, path.join(cwd, "demo"));

  // minimal §8 structure
  assert.ok(fs.existsSync(path.join(cwd, "demo", "slad.config.ts")));
  assert.ok(fs.existsSync(path.join(cwd, "demo", "package.json")));
  assert.ok(fs.existsSync(path.join(cwd, "demo", "agents", "demo.agent.ts")));
  assert.ok(fs.existsSync(path.join(cwd, "demo", "tools")));

  // placeholders fully substituted
  const agent = fs.readFileSync(path.join(cwd, "demo", "agents", "demo.agent.ts"), "utf8");
  assert.ok(!agent.includes("{{"), "no placeholder left in agent file");
  assert.match(agent, /demoAgent/);

  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "demo", "package.json"), "utf8")) as {
    name: string;
  };
  assert.equal(pkg.name, "demo");
});

test("create agent --template enterprise scaffolds the full §8 layout", () => {
  const cwd = tmpDir();
  generate("agent", "acme", { cwd, blueprintsDir, template: "enterprise" });

  for (const d of [
    "agents",
    "tools",
    "stages",
    "pipelines",
    "prompts",
    "policies",
    "memory",
    "runtime",
    "api",
    "evals",
    "observability",
    "tests",
    "docs",
  ]) {
    assert.ok(fs.existsSync(path.join(cwd, "acme", d)), `missing dir: ${d}`);
  }
  assert.ok(fs.existsSync(path.join(cwd, "acme", "tools", "registry.ts")));
});

test("create tool drops a typed tool file into cwd", () => {
  const cwd = tmpDir();
  const res = generate("tool", "fetchIssues", { cwd, blueprintsDir });

  const file = path.join(cwd, "fetchIssues.ts");
  assert.ok(fs.existsSync(file));
  assert.ok(res.files.includes(file));

  const src = fs.readFileSync(file, "utf8");
  assert.ok(!src.includes("{{"), "no placeholder left in tool file");
  assert.match(src, /fetchIssuesTool/);
  assert.match(src, /id: "fetch-issues"/);
});

test("create stage and pipeline generate single files into cwd", () => {
  const cwd = tmpDir();
  generate("stage", "summarize", { cwd, blueprintsDir });
  generate("pipeline", "review", { cwd, blueprintsDir });

  assert.ok(fs.existsSync(path.join(cwd, "summarize.ts")));
  assert.ok(fs.existsSync(path.join(cwd, "review.ts")));
  assert.match(fs.readFileSync(path.join(cwd, "review.ts"), "utf8"), /reviewPipeline/);
});

test("rejects invalid name and refuses to overwrite an existing project", () => {
  const cwd = tmpDir();
  assert.throws(() => generate("agent", "1bad", { cwd, blueprintsDir }), /inv[aá]lido/i);

  generate("agent", "dup", { cwd, blueprintsDir });
  assert.throws(() => generate("agent", "dup", { cwd, blueprintsDir }), /existe/i);
});
