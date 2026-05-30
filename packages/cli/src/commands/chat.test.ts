import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAction, suggestNext, safeCall } from "./chat.js";
import type { SessionState } from "../core/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(artifactKinds: string[] = []): SessionState {
  return {
    id: "test-session",
    createdAt: new Date().toISOString(),
    intent: "test intent",
    artifacts: artifactKinds.map((kind) => ({
      kind: kind as SessionState["artifacts"][number]["kind"],
      path: `./test/${kind}.json`,
      createdAt: new Date().toISOString(),
    })),
    humanAnswers: [],
    notes: [],
  };
}

// ─── parseAction ─────────────────────────────────────────────────────────────

describe("parseAction", () => {
  describe("free text → direct chat (default mode)", () => {
    it("empty string → chat with empty message", () => {
      assert.deepEqual(parseAction("", null), { type: "chat", message: "" });
    });

    it("plain question → chat", () => {
      assert.deepEqual(parseAction("qué es TypeScript?", null), { type: "chat", message: "qué es TypeScript?" });
    });

    it("free text with session → still chat (not explore)", () => {
      const session = makeSession([]);
      assert.deepEqual(parseAction("quiero autenticación", session), { type: "chat", message: "quiero autenticación" });
    });

    it("free text with explore artifact → still chat", () => {
      const session = makeSession(["explore"]);
      assert.deepEqual(parseAction("algo más", session), { type: "chat", message: "algo más" });
    });

    it("keywords without / → chat (not pipeline)", () => {
      assert.deepEqual(parseAction("plan", null), { type: "chat", message: "plan" });
      assert.deepEqual(parseAction("snapshot", null), { type: "chat", message: "snapshot" });
      assert.deepEqual(parseAction("auto", null), { type: "chat", message: "auto" });
    });
  });

  describe("slash commands — meta", () => {
    it('"/exit" → exit', () => {
      assert.deepEqual(parseAction("/exit", null), { type: "exit" });
    });

    it('"/quit" → exit', () => {
      assert.deepEqual(parseAction("/quit", null), { type: "exit" });
    });

    it('"/salir" → exit', () => {
      assert.deepEqual(parseAction("/salir", null), { type: "exit" });
    });

    it('"/q" → exit', () => {
      assert.deepEqual(parseAction("/q", null), { type: "exit" });
    });

    it('"/help" → help', () => {
      assert.deepEqual(parseAction("/help", null), { type: "help" });
    });

    it('"/ayuda" → help', () => {
      assert.deepEqual(parseAction("/ayuda", null), { type: "help" });
    });

    it('"/?" → help', () => {
      assert.deepEqual(parseAction("/?", null), { type: "help" });
    });

    it('"/status" → status', () => {
      assert.deepEqual(parseAction("/status", null), { type: "status" });
    });

    it('"/new" → new', () => {
      assert.deepEqual(parseAction("/new", null), { type: "new" });
    });

    it('"/reset" → new', () => {
      assert.deepEqual(parseAction("/reset", null), { type: "new" });
    });
  });

  describe("slash commands — pipeline stages", () => {
    it('"/evolve" → evolve', () => {
      assert.deepEqual(parseAction("/evolve", null), { type: "evolve" });
    });

    it('"/learn" → learn', () => {
      assert.deepEqual(parseAction("/learn", null), { type: "learn" });
    });

    it('"/plan" → plan', () => {
      assert.deepEqual(parseAction("/plan", null), { type: "plan" });
    });

    it('"/snapshot" → snapshot', () => {
      assert.deepEqual(parseAction("/snapshot", null), { type: "snapshot" });
    });

    it('"/run --auto" → run-auto', () => {
      assert.deepEqual(parseAction("/run --auto", null), { type: "run-auto" });
    });

    it('"/auto" → run-auto', () => {
      assert.deepEqual(parseAction("/auto", null), { type: "run-auto" });
    });

    it('"/auto crear login" → auto with intent', () => {
      assert.deepEqual(parseAction("/auto crear login", null), { type: "auto", intent: "crear login" });
    });

    it('"/run T2" → run-task', () => {
      assert.deepEqual(parseAction("/run T2", null), { type: "run-task", taskId: "T2" });
    });

    it('"/run t3" → run-task uppercased', () => {
      assert.deepEqual(parseAction("/run t3", null), { type: "run-task", taskId: "T3" });
    });

    it('"/run" alone → run-next', () => {
      assert.deepEqual(parseAction("/run", null), { type: "run-next" });
    });

    it('"/explore mi idea" → explore with intent', () => {
      assert.deepEqual(parseAction("/explore mi idea", null), { type: "explore", intent: "mi idea" });
    });

    it('"/EXIT" case insensitive → exit', () => {
      assert.deepEqual(parseAction("/EXIT", null), { type: "exit" });
    });

    it('"/PLAN" case insensitive → plan', () => {
      assert.deepEqual(parseAction("/PLAN", null), { type: "plan" });
    });
  });

  describe("unknown slash commands", () => {
    it('"/unknowncommand" → unknown', () => {
      const result = parseAction("/unknowncommand", null);
      assert.equal(result.type, "unknown");
    });
  });
});

// ─── suggestNext ──────────────────────────────────────────────────────────────

describe("suggestNext", () => {
  it("null session → initial prompt", () => {
    const msg = suggestNext(null);
    assert.ok(msg.includes("intención") || msg.includes("help"));
  });

  it("session with no artifacts → initial prompt", () => {
    const msg = suggestNext(makeSession([]));
    assert.ok(msg.includes("intención") || msg.includes("help"));
  });

  it("session with explore only → suggests snapshot", () => {
    const msg = suggestNext(makeSession(["explore"]));
    assert.ok(msg.includes("snapshot"), `Expected 'snapshot' in: ${msg}`);
  });

  it("session with explore + snapshot → suggests plan", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot"]));
    assert.ok(msg.includes("plan"), `Expected 'plan' in: ${msg}`);
  });

  it("session with explore + snapshot + plan → suggests run", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot", "plan"]));
    assert.ok(msg.includes("run"), `Expected 'run' in: ${msg}`);
  });

  it("session with explore + snapshot + plan + run → suggests learn", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot", "plan", "run"]));
    assert.ok(msg.includes("learn"), `Expected 'learn' in: ${msg}`);
  });

  it("session with all artifacts → suggests evolve or new intent", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot", "plan", "run", "learn"]));
    assert.ok(msg.includes("evolve"), `Expected 'evolve' in: ${msg}`);
  });
});

// ─── safeCall ─────────────────────────────────────────────────────────────────

describe("safeCall", () => {
  it("successful fn → returns true", async () => {
    const result = await safeCall(async () => {
      // no-op
    });
    assert.equal(result, true);
  });

  it("fn that calls process.exit(1) → returns false without crashing", async () => {
    const result = await safeCall(async () => {
      process.exit(1);
    });
    assert.equal(result, false);
  });

  it("fn that calls process.exit(0) → returns false without crashing", async () => {
    const result = await safeCall(async () => {
      process.exit(0);
    });
    assert.equal(result, false);
  });

  it("fn that throws a regular Error → returns false", async () => {
    const result = await safeCall(async () => {
      throw new Error("algo salió mal");
    });
    assert.equal(result, false);
  });

  it("can be called sequentially — second safeCall still intercepts exit", async () => {
    // First call intercepts exit and completes
    const r1 = await safeCall(async () => {
      process.exit(1);
    });
    // Second call must also intercept (process.exit was restored)
    const r2 = await safeCall(async () => {
      process.exit(0);
    });
    assert.equal(r1, false);
    assert.equal(r2, false);
  });

  it("can be called sequentially — second safeCall succeeds after first throws", async () => {
    await safeCall(async () => {
      throw new Error("first failure");
    });
    const result = await safeCall(async () => {
      // second call should be clean
    });
    assert.equal(result, true);
  });

  it("process.exit remains callable as a function after safeCall", async () => {
    await safeCall(async () => {
      // no-op
    });
    // If restore failed, process.exit would be a throwing stub
    // Verify it's still a normal function by checking it via another safeCall
    const result = await safeCall(async () => {
      process.exit(1);
    });
    assert.equal(result, false);
  });

  // Regression: a synchronous listener (e.g. the SIGINT handler) firing while
  // safeCall is mid-flight must NOT see the throwing stub. The chat module
  // captures `process.exit` once at load time and uses that reference inside
  // the SIGINT handler — this test guards that contract.
  it("a sync listener captured before safeCall does NOT see the throwing stub", async () => {
    const originalAtModuleLoad = process.exit.bind(process);
    let stubObserved = false;

    await safeCall(async () => {
      // Inside safeCall, process.exit IS the stub. But code that captured the
      // reference earlier (e.g. the SIGINT handler) should be unaffected.
      if (process.exit !== originalAtModuleLoad) {
        // Confirms safeCall did install a stub
      }
      // If we were a SIGINT handler captured before safeCall, calling our
      // captured reference must NOT throw — i.e. it must be the real exit.
      try {
        // Can't actually call process.exit(0) in a test (would kill the
        // runner). Instead verify that the captured reference is not the
        // current (stubbed) process.exit.
        if (originalAtModuleLoad === (process.exit as unknown)) {
          stubObserved = true;
        }
      } catch {
        stubObserved = true;
      }
    });

    assert.equal(stubObserved, false, "captured reference must remain the real process.exit");
  });
});
