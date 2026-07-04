import { stripEmptyCollections, toCompactJson } from "./json.js";
import { ExploreOutput, RunOutput } from "./schemas.js";

// @ts-ignore @slad/shared does not take a direct @types/node dependency.
const { describe, it } = await import("node:test");
// @ts-ignore @slad/shared does not take a direct @types/node dependency.
const { default: assert } = await import("node:assert/strict");

describe("stripEmptyCollections", () => {
  it("drops empty arrays and empty objects, keeps scalars and empty strings", () => {
    const cleaned = stripEmptyCollections({
      summary: "done",
      notes: "",
      count: 0,
      flag: false,
      decisions: [],
      humanAnswers: {},
      nested: { keep: [1], drop: [] },
    });
    assert.deepEqual(cleaned, {
      summary: "done",
      notes: "",
      count: 0,
      flag: false,
      nested: { keep: [1] },
    });
  });

  it("cleans array elements without removing them", () => {
    const cleaned = stripEmptyCollections([{ a: 1, b: [] }, { c: {} }]);
    assert.deepEqual(cleaned, [{ a: 1 }, {}]);
  });

  it("round-trips through the RunOutput schema", () => {
    const output = RunOutput.parse({
      taskId: "T1",
      status: "completed",
      summary: "ok",
    });
    const restored = RunOutput.parse(stripEmptyCollections(output));
    assert.deepEqual(restored, output);
  });

  it("round-trips through the ExploreOutput schema", () => {
    const output = ExploreOutput.parse({
      reframing: "clearer problem",
      approaches: [{ name: "a", summary: "s", pros: [], cons: [] }],
      risks: [],
      openQuestions: [],
      recommendedNext: "do it",
    });
    const restored = ExploreOutput.parse(stripEmptyCollections(output));
    assert.deepEqual(restored, output);
  });
});

describe("toCompactJson", () => {
  it("serializes without indentation or empty collections", () => {
    assert.equal(toCompactJson({ a: 1, b: [], c: { d: "x" } }), '{"a":1,"c":{"d":"x"}}');
  });
});
