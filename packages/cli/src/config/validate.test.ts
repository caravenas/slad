import test from "node:test";
import assert from "node:assert/strict";

import { MAX_RETRIES, TIMEOUT_MS } from "./defaults.js";
import { validateConfig } from "./validate.js";

const defaults = {
  TIMEOUT_MS,
  MAX_RETRIES
};

test("validateConfig returns true for default values", () => {
  assert.equal(validateConfig(defaults), true);
});

test("validateConfig throws when TIMEOUT_MS is 0", () => {
  assert.throws(
    () => validateConfig({ ...defaults, TIMEOUT_MS: 0 }),
    new Error("TIMEOUT_MS must be greater than 0")
  );
});

test("validateConfig throws when MAX_RETRIES is negative", () => {
  assert.throws(
    () => validateConfig({ ...defaults, MAX_RETRIES: -1 }),
    new Error("MAX_RETRIES must be greater than or equal to 0")
  );
});
