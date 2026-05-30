import assert from "node:assert/strict";
import test from "node:test";

import { createBootUi, type BootEvent } from "./ui.js";

function setIsTty(stream: NodeJS.WriteStream, value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", {
    configurable: true,
    get: () => value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    }
  };
}

test("boot ui no-TTY usa null UI y no banner visual", async () => {
  const restoreStdout = setIsTty(process.stdout, false);
  const restoreStderr = setIsTty(process.stderr, false);
  const prevCi = process.env.CI;
  delete process.env.CI;

  const events: BootEvent[] = [];
  try {
    const ui = createBootUi({ onEvent: (event) => events.push(event) });
    await ui.showBanner();
    ui.start("iniciando");
    await ui.fail("error breve", { lingerMs: 0 });

    assert.equal(events[0]?.type, "banner");
    const banner = events[0] as Extract<BootEvent, { type: "banner" }>;
    assert.equal(banner.content, "");
    assert.equal(events.some((event) => event.type === "error"), true);
    assert.equal(events.some((event) => event.type === "stop"), true);
  } finally {
    restoreStdout();
    restoreStderr();
    if (prevCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = prevCi;
    }
  }
});
