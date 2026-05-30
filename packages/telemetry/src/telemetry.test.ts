import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoopTelemetry } from "./noop.js";
import { LDJSONTelemetry } from "./ldjson.js";

describe("NoopTelemetry", () => {
  test("startSpan returns a span that can be ended without error", () => {
    const span = NoopTelemetry.startSpan("test-span", { key: "val" });
    span.setAttribute("x", 1);
    span.end({ result: "ok" });
  });

  test("emit does nothing without error", () => {
    NoopTelemetry.emit("event", { data: 1 });
  });
});

describe("LDJSONTelemetry", () => {
  let tmpDir: string;
  let logPath: string;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-tel-"));
    logPath = path.join(tmpDir, "telemetry.ldjson");
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("writes span records to LDJSON file", () => {
    const tel = new LDJSONTelemetry(logPath);
    const span = tel.startSpan("explore", { pipelineId: "test" });
    span.setAttribute("stageId", "explore");
    span.end();

    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!);
    assert.equal(record.type, "span");
    assert.equal(record.name, "explore");
    assert.equal(record.stageId, "explore");
    assert.ok(typeof record.durationMs === "number");
  });

  test("emit writes event records", () => {
    const tel = new LDJSONTelemetry(logPath);
    tel.emit("stage.complete", { stageId: "plan" });

    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]!);
    assert.equal(last.type, "event");
    assert.equal(last.event, "stage.complete");
    assert.equal(last.stageId, "plan");
  });
});
