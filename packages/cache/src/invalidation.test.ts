import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureRelevantFiles,
  createReusableCacheMetadata,
  evaluateReusableCacheEntry,
} from "./invalidation.js";

test("captureRelevantFiles records a stable manifest for retrieved_context inputs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-relevant-"));
  const sourcePath = path.join(cwd, "docs", "context.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "initial context\n", "utf8");

  const manifest = captureRelevantFiles(["docs/context.md", "./docs/context.md"], { cwd });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0]?.path, "docs/context.md");
  assert.match(manifest.files[0]?.hash ?? "", /^[a-f0-9]{64}$/);
});

test("evaluateReusableCacheEntry returns a hit when key parts and relevant files are unchanged", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-hit-"));
  const sourcePath = path.join(cwd, "docs", "context.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "initial context\n", "utf8");

  const cached = createReusableCacheMetadata({
    cwd,
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    relevantFilePaths: ["docs/context.md"],
  });

  const evaluation = evaluateReusableCacheEntry({
    cached,
    cwd,
    current: {
      snapshotHash: "snapshot-a",
      inputSignature: "input-a",
      toolVersion: "cli-0.1.0",
      runtimeVersion: "gpt-5",
    },
  });

  assert.deepEqual(evaluation, { reusable: true, reason: "hit" });
});

test("evaluateReusableCacheEntry misses deterministically when snapshot or inputs change", () => {
  const cached = createReusableCacheMetadata({
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
  });

  const snapshotMiss = evaluateReusableCacheEntry({
    cached,
    current: {
      snapshotHash: "snapshot-b",
      inputSignature: "input-a",
      toolVersion: "cli-0.1.0",
      runtimeVersion: "gpt-5",
    },
  });
  const inputMiss = evaluateReusableCacheEntry({
    cached,
    current: {
      snapshotHash: "snapshot-a",
      inputSignature: "input-b",
      toolVersion: "cli-0.1.0",
      runtimeVersion: "gpt-5",
    },
  });

  assert.deepEqual(snapshotMiss, { reusable: false, reason: "key_mismatch" });
  assert.deepEqual(inputMiss, { reusable: false, reason: "key_mismatch" });
});

test("evaluateReusableCacheEntry misses deterministically when tool or runtime versions change", () => {
  const cached = createReusableCacheMetadata({
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
  });

  const toolVersionMiss = evaluateReusableCacheEntry({
    cached,
    current: {
      snapshotHash: "snapshot-a",
      inputSignature: "input-a",
      toolVersion: "cli-0.2.0",
      runtimeVersion: "gpt-5",
    },
  });
  const runtimeVersionMiss = evaluateReusableCacheEntry({
    cached,
    current: {
      snapshotHash: "snapshot-a",
      inputSignature: "input-a",
      toolVersion: "cli-0.1.0",
      runtimeVersion: "gpt-5.1",
    },
  });

  assert.deepEqual(toolVersionMiss, { reusable: false, reason: "key_mismatch" });
  assert.deepEqual(runtimeVersionMiss, { reusable: false, reason: "key_mismatch" });
});

test("evaluateReusableCacheEntry invalidates retrieved_context when relevant files change", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-miss-"));
  const sourcePath = path.join(cwd, "docs", "context.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "initial context\n", "utf8");

  const cached = createReusableCacheMetadata({
    cwd,
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    relevantFilePaths: ["docs/context.md"],
  });

  fs.writeFileSync(sourcePath, "updated context\n", "utf8");

  const evaluation = evaluateReusableCacheEntry({
    cached,
    cwd,
    current: {
      snapshotHash: "snapshot-a",
      inputSignature: "input-a",
      toolVersion: "cli-0.1.0",
      runtimeVersion: "gpt-5",
    },
  });

  assert.deepEqual(evaluation, { reusable: false, reason: "relevant_files_changed" });
});

test("evaluateReusableCacheEntry invalidates when a relevant file disappears", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-missing-"));
  const sourcePath = path.join(cwd, "docs", "context.md");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "initial context\n", "utf8");

  const cached = createReusableCacheMetadata({
    cwd,
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    relevantFilePaths: ["docs/context.md"],
  });

  fs.rmSync(sourcePath);

  const evaluation = evaluateReusableCacheEntry({
    cached,
    cwd,
    current: {
      snapshotHash: "snapshot-a",
      inputSignature: "input-a",
      toolVersion: "cli-0.1.0",
      runtimeVersion: "gpt-5",
    },
  });

  assert.deepEqual(evaluation, { reusable: false, reason: "relevant_files_missing" });
});
