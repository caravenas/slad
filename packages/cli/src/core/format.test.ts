import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration } from "./format.js";

test("formatDuration handles requested edge cases", () => {
  assert.equal(formatDuration(0), "0ms");

  assert.equal(formatDuration(-1), "-1ms");
  assert.equal(formatDuration(-59_950), "-1m");

  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1_000), "1s");

  assert.equal(formatDuration(59_940), "59.9s");
  assert.equal(formatDuration(59_950), "1m");

  assert.equal(formatDuration(3_599_900), "1h 0m");

  assert.equal(formatDuration(86_340_000), "23h 59m");
  assert.equal(formatDuration(86_400_000), "1d 0h");
  assert.equal(formatDuration(176_400_000), "2d 1h");
});
