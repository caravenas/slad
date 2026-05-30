import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.js";

// Capture console output for testing
function captureConsole() {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.warn = (...args: unknown[]) => warns.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  return {
    logs,
    warns,
    errors,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

describe("createLogger", () => {
  describe('level: "error"', () => {
    it("no logea debug ni info ni warn", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "error" });
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.success("success msg");
      logger.dim("dim msg");
      logger.title("title msg");
      capture.restore();

      assert.equal(capture.logs.length, 0);
      assert.equal(capture.warns.length, 0);
      assert.equal(capture.errors.length, 0);
    });

    it("logea error", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "error" });
      logger.error("error msg");
      capture.restore();

      assert.equal(capture.errors.length, 1);
      assert.ok(capture.errors[0].includes("error msg"));
    });
  });

  describe('level: "silent"', () => {
    it("no logea nada", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "silent" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      capture.restore();

      assert.equal(capture.logs.length, 0);
      assert.equal(capture.warns.length, 0);
      assert.equal(capture.errors.length, 0);
    });
  });

  describe('level: "debug"', () => {
    it("logea todo", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "debug" });
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");
      capture.restore();

      // debug + info + success family → console.log
      assert.ok(capture.logs.some((l) => l.includes("debug msg")));
      assert.ok(capture.logs.some((l) => l.includes("info msg")));
      assert.ok(capture.warns.some((l) => l.includes("warn msg")));
      assert.ok(capture.errors.some((l) => l.includes("error msg")));
    });
  });

  describe("API retrocompatible", () => {
    it(".dim() existe y funciona con level info", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "info" });
      logger.dim("dim message");
      capture.restore();
      assert.ok(capture.logs.some((l) => l.includes("dim message")));
    });

    it(".title() existe y funciona", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "info" });
      logger.title("Title here");
      capture.restore();
      assert.ok(capture.logs.some((l) => l.includes("Title here")));
    });

    it(".success() existe y funciona", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "info" });
      logger.success("all good");
      capture.restore();
      assert.ok(capture.logs.some((l) => l.includes("all good")));
    });
  });

  describe("error con cause", () => {
    it("muestra cause message cuando existe", () => {
      const capture = captureConsole();
      const logger = createLogger({ level: "error" });
      const cause = new Error("root cause");
      const err = new Error("wrapper");
      err.cause = cause;
      logger.error("something failed", err);
      capture.restore();

      assert.ok(capture.errors.some((l) => l.includes("root cause")));
    });
  });
});
