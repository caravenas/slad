import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPromptFrame,
  clampSelection,
  renderSubmittedLine,
  stripAnsi,
  visibleWidth,
  type PromptSlashItem,
} from "./chat-prompt.js";

const items: PromptSlashItem[] = [
  { insertion: "/explore ", signature: "/explore <intent>", description: "Explora…", hasArgs: true },
  { insertion: "/help", signature: "/help", description: "Show help", hasArgs: false },
];

test("visibleWidth ignores ANSI color codes", () => {
  assert.equal(visibleWidth("\x1b[36m❯\x1b[0m"), 1);
  assert.equal(stripAnsi("\x1b[2;9m hi \x1b[0m"), " hi ");
});

test("buildPromptFrame: input wrapped by top/bottom rules, no dropdown", () => {
  const frame = buildPromptFrame({
    value: "hola",
    promptPrefix: "❯",
    width: 40,
    suggestions: [],
    selected: 0,
  });
  assert.equal(frame.lines.length, 3);
  assert.equal(frame.inputLineIndex, 1);
  assert.ok(/^─+$/.test(stripAnsi(frame.lines[0])), "top rule");
  assert.ok(/^─+$/.test(stripAnsi(frame.lines[2])), "bottom rule");
  assert.equal(stripAnsi(frame.lines[1]), " ❯ hola");
  // cursor sits just after the value: " ❯ hola" → column 7
  assert.equal(frame.cursorCol, " ❯ hola".length);
});

test("buildPromptFrame: dropdown lines + hint when suggestions present", () => {
  const frame = buildPromptFrame({
    value: "/cr",
    promptPrefix: "❯",
    width: 60,
    suggestions: items,
    selected: 1,
  });
  // 3 frame lines + 2 items + 1 hint
  assert.equal(frame.lines.length, 6);
  const rendered = frame.lines.map(stripAnsi);
  assert.ok(rendered.some((l) => l.includes("/explore <intent>")));
  assert.ok(rendered.some((l) => l.includes("/help")));
  // selected (index 1 = /help) carries the ❯ marker
  const helpLine = rendered.find((l) => l.includes("/help"))!;
  assert.ok(helpLine.trimStart().startsWith("❯"));
});

test("buildPromptFrame: windows long lists and shows scroll counts", () => {
  const many: PromptSlashItem[] = Array.from({ length: 15 }, (_, i) => ({
    insertion: `/c${i}`,
    signature: `/c${i}`,
    description: `d${i}`,
    hasArgs: false,
  }));
  const frame = buildPromptFrame({
    value: "/c",
    promptPrefix: "❯",
    width: 60,
    suggestions: many,
    selected: 12,
  });
  const dropdown = frame.lines.slice(3).map(stripAnsi); // after the 3 box lines
  assert.equal(dropdown.length, 9, "8 visible rows + 1 hint");
  assert.ok(dropdown.some((l) => l.includes("/c12")), "selected item is in view");
  assert.ok(dropdown[dropdown.length - 1].includes("↑"), "shows a scroll-up count");
});

test("clampSelection wraps around", () => {
  assert.equal(clampSelection(0, 0), 0);
  assert.equal(clampSelection(-1, 3), 2);
  assert.equal(clampSelection(3, 3), 0);
  assert.equal(clampSelection(1, 3), 1);
});

test("renderSubmittedLine: single attenuated line, no bar, no strikethrough", () => {
  const out = renderSubmittedLine("/plan");
  assert.ok(!out.includes("\n"), "single line (no bar above)");
  assert.equal(stripAnsi(out), "› /plan");
  assert.ok(!out.includes("\x1b[9m"), "no strikethrough");
  assert.equal(renderSubmittedLine("   "), "");
});
