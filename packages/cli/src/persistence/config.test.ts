import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { loadProjectConfig, resolveDocsRoot } from "../core/project-config.js";
import { ConfigError } from "../core/errors.js";
import { resetDocsRootCache } from "./layout.js";

let tmpDir: string;

async function writeConfig(dir: string, content: string): Promise<void> {
  const sladDir = path.join(dir, ".slad-os");
  await mkdir(sladDir, { recursive: true });
  await writeFile(path.join(sladDir, "config.json"), content, "utf8");
}

describe("persistence/config — docsRoot resolution", () => {
  beforeEach(async () => {
    resetDocsRootCache();
    delete process.env.SLAD_DOCS_PATH;
    tmpDir = await (async () => {
      const d = path.join(os.tmpdir(), `slad-config-test-${Date.now()}`);
      await mkdir(d, { recursive: true });
      return d;
    })();
  });

  afterEach(async () => {
    resetDocsRootCache();
    delete process.env.SLAD_DOCS_PATH;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Default sin config ni env ─────────────────────────────────────

  it("1. default sin config ni env → <cwd>/docs", async () => {
    const config = await loadProjectConfig(tmpDir);
    const docsRoot = resolveDocsRoot(config, tmpDir);
    assert.equal(docsRoot, path.resolve(tmpDir, "docs"));
  });

  // ── Test 2: Config con docsPath relativo ──────────────────────────────────

  it("2. config file con docsPath relativo → <cwd>/documentation", async () => {
    await writeConfig(tmpDir, JSON.stringify({ docsPath: "documentation" }));
    const config = await loadProjectConfig(tmpDir);
    const docsRoot = resolveDocsRoot(config, tmpDir);
    assert.equal(docsRoot, path.resolve(tmpDir, "documentation"));
  });

  // ── Test 3: Config con docsPath absoluto ──────────────────────────────────

  it("3. config file con docsPath absoluto → ese path tal cual", async () => {
    const absolutePath = path.join(os.tmpdir(), "slad-absolute-docs");
    await writeConfig(tmpDir, JSON.stringify({ docsPath: absolutePath }));
    const config = await loadProjectConfig(tmpDir);
    const docsRoot = resolveDocsRoot(config, tmpDir);
    assert.equal(docsRoot, absolutePath);
  });

  // ── Test 4: Env var SLAD_DOCS_PATH relativo ───────────────────────────────

  it("4. env var SLAD_DOCS_PATH relativo → resuelve desde cwd", async () => {
    process.env.SLAD_DOCS_PATH = "custom-docs";
    const config = await loadProjectConfig(tmpDir);
    const docsRoot = resolveDocsRoot(config, tmpDir);
    assert.equal(docsRoot, path.resolve(tmpDir, "custom-docs"));
  });

  // ── Test 5: Env var SLAD_DOCS_PATH absoluto ───────────────────────────────

  it("5. env var SLAD_DOCS_PATH absoluto → ese path tal cual", async () => {
    const absolutePath = path.join(os.tmpdir(), "slad-env-absolute");
    process.env.SLAD_DOCS_PATH = absolutePath;
    const config = await loadProjectConfig(tmpDir);
    const docsRoot = resolveDocsRoot(config, tmpDir);
    assert.equal(docsRoot, absolutePath);
  });

  // ── Test 6: Env var override gana sobre config file ──────────────────────

  it("6. env var override gana sobre config file", async () => {
    await writeConfig(tmpDir, JSON.stringify({ docsPath: "from-config" }));
    process.env.SLAD_DOCS_PATH = "from-env";
    const config = await loadProjectConfig(tmpDir);
    const docsRoot = resolveDocsRoot(config, tmpDir);
    assert.equal(docsRoot, path.resolve(tmpDir, "from-env"));
  });

  // ── Test 7: Config con JSON inválido → ConfigError ───────────────────────

  it("7. config file con JSON inválido → ConfigError lanzado", async () => {
    await writeConfig(tmpDir, "{ invalid json {{");
    await assert.rejects(
      () => loadProjectConfig(tmpDir),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `Expected ConfigError, got: ${err}`);
        return true;
      },
    );
  });

  // ── Test 8: Config file ausente → defaults, sin error ────────────────────

  it("8. config file ausente → defaults sin error", async () => {
    // tmpDir has no .slad-os/config.json
    const config = await loadProjectConfig(tmpDir);
    assert.equal(config.docsPath, "docs");
  });
});
