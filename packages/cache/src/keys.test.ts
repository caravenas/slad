import assert from "node:assert/strict";
import test from "node:test";

import { CACHE_SCHEMA_VERSION, createReuseKey } from "./keys.js";

test("createReuseKey indexes reusable entries by snapshot, inputs, tool/runtime and schema versions", () => {
  const key = createReuseKey({
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
  });

  assert.equal(key.snapshotHash, "snapshot-a");
  assert.equal(key.inputSignature, "input-a");
  assert.equal(key.toolVersion, "cli-0.1.0");
  assert.equal(key.runtimeVersion, "gpt-5");
  assert.equal(key.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.match(key.key, /^[a-f0-9]{64}$/);
});

test("createReuseKey changes deterministically when snapshot, inputs or versions change", () => {
  const base = createReuseKey({
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    schemaVersion: "1",
  });
  const differentSnapshot = createReuseKey({
    snapshotHash: "snapshot-b",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    schemaVersion: "1",
  });
  const differentInput = createReuseKey({
    snapshotHash: "snapshot-a",
    inputSignature: "input-b",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    schemaVersion: "1",
  });
  const differentSchema = createReuseKey({
    snapshotHash: "snapshot-a",
    inputSignature: "input-a",
    toolVersion: "cli-0.1.0",
    runtimeVersion: "gpt-5",
    schemaVersion: "2",
  });

  assert.notEqual(base.key, differentSnapshot.key);
  assert.notEqual(base.key, differentInput.key);
  assert.notEqual(base.key, differentSchema.key);
});
