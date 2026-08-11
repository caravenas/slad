import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createInterruptScope, INTERRUPT_EXIT_CODE } from "./interrupt.js";

/** Stand-in for `process` so tests never install real signal handlers. */
function fakeProcess() {
  const emitter = new EventEmitter();
  return {
    target: {
      on: (event: string, listener: (...args: unknown[]) => void) => { emitter.on(event, listener); return process; },
      off: (event: string, listener: (...args: unknown[]) => void) => { emitter.off(event, listener); return process; },
    } as unknown as Pick<NodeJS.Process, "on" | "off">,
    emit: (event: string) => emitter.emit(event),
    listenerCount: (event: string) => emitter.listenerCount(event),
  };
}

describe("createInterruptScope", () => {
  it("la primera señal aborta y notifica sin salir del proceso", () => {
    const host = fakeProcess();
    const exits: number[] = [];
    const scope = createInterruptScope({ target: host.target, hardExit: (code) => exits.push(code) });
    const seen: string[] = [];
    scope.onInterrupt((signal) => seen.push(signal));

    assert.equal(scope.interrupted(), false);
    host.emit("SIGINT");

    assert.equal(scope.interrupted(), true);
    assert.equal(scope.interruptedBy(), "SIGINT");
    assert.equal(scope.signal.aborted, true);
    assert.deepEqual(seen, ["SIGINT"]);
    assert.deepEqual(exits, [], "la primera señal nunca llama a process.exit");
    scope.dispose();
  });

  it("la segunda señal sale duro con 130 y no vuelve a notificar", () => {
    const host = fakeProcess();
    const exits: number[] = [];
    const scope = createInterruptScope({ target: host.target, hardExit: (code) => exits.push(code) });
    let notifications = 0;
    scope.onInterrupt(() => { notifications += 1; });

    host.emit("SIGINT");
    host.emit("SIGINT");

    assert.equal(notifications, 1);
    assert.deepEqual(exits, [INTERRUPT_EXIT_CODE]);
    scope.dispose();
  });

  it("SIGTERM se atrapa igual que SIGINT", () => {
    const host = fakeProcess();
    const scope = createInterruptScope({ target: host.target, hardExit: () => undefined });
    host.emit("SIGTERM");
    assert.equal(scope.interruptedBy(), "SIGTERM");
    scope.dispose();
  });

  it("un listener que lanza no impide el desenrollado", () => {
    const host = fakeProcess();
    const scope = createInterruptScope({ target: host.target, hardExit: () => undefined });
    scope.onInterrupt(() => { throw new Error("boom"); });
    let reached = false;
    scope.onInterrupt(() => { reached = true; });

    host.emit("SIGINT");

    assert.equal(reached, true);
    assert.equal(scope.signal.aborted, true);
    scope.dispose();
  });

  it("dispose desregistra los handlers y es idempotente", () => {
    const host = fakeProcess();
    const scope = createInterruptScope({ target: host.target, hardExit: () => undefined });
    assert.equal(host.listenerCount("SIGINT"), 1);
    scope.dispose();
    scope.dispose();
    assert.equal(host.listenerCount("SIGINT"), 0);
    assert.equal(host.listenerCount("SIGTERM"), 0);
  });
});
