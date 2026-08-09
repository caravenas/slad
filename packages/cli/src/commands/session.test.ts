import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createSession, getActiveSessionId, listSessions, setActiveSession } from "../core/session.js";
import type { BootEvent, BootUi, BootUiOptions } from "../cli/ui.js";
import { sessionResumeCommand, sessionStartCommand, shouldRenderVisualBootUiForEnv } from "./session.js";
import { resetDocsRootCache } from "../persistence/layout.js";

const originalDocsPath = process.env.SLAD_DOCS_PATH;
const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));
const TSX_LOADER = import.meta.resolve("tsx/esm");

test.beforeEach(() => {
  delete process.env.SLAD_DOCS_PATH;
  resetDocsRootCache();
});

test.afterEach(() => {
  if (originalDocsPath === undefined) {
    delete process.env.SLAD_DOCS_PATH;
  } else {
    process.env.SLAD_DOCS_PATH = originalDocsPath;
  }
  resetDocsRootCache();
});

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, SLAD_DOCS_PATH: path.join(cwd, "docs") },
    timeout: 10_000,
  });
}

function createBootUiSpy(events: BootEvent[], enabledValues: boolean[]) {
  return (opts: BootUiOptions): BootUi => {
    enabledValues.push(Boolean(opts.enabled));
    const emit = (event: BootEvent): void => {
      events.push(event);
      opts.onEvent?.(event);
    };

    return {
      async showBanner(): Promise<void> {
        emit({ type: "banner", content: "SLAD OS vtest" });
      },
      start(message: string): void {
        emit({ type: "start", message });
      },
      milestone(milestone, message): void {
        emit({ type: "milestone", milestone, message: message ?? milestone });
      },
      succeed(message: string): void {
        emit({ type: "succeed", message });
      },
      async fail(message: string, failOpts): Promise<void> {
        emit({ type: "error", message, lingerMs: failOpts?.lingerMs ?? 0 });
        emit({ type: "stop" });
      },
      stop(): void {
        emit({ type: "stop" });
      },
    };
  };
}

test("session start nueva sesión emite banner/progreso por hitos", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-ui-new-");
  process.chdir(project);

  const events: BootEvent[] = [];
  const enabledValues: boolean[] = [];

  try {
    await sessionStartCommand("crear sesion de prueba", {
      bootUiFactory: createBootUiSpy(events, enabledValues),
    });

    assert.deepEqual(enabledValues, [false]);
    assert.equal(events.some((event) => event.type === "banner"), true);
    assert.equal(events.some((event) => event.type === "start"), true);

    const milestones = events
      .filter((event): event is Extract<BootEvent, { type: "milestone" }> => event.type === "milestone")
      .map((event) => event.milestone);
    assert.deepEqual(milestones, ["config", "persistence"]);
    assert.equal(events.some((event) => event.type === "succeed"), true);
  } finally {
    process.chdir(cwd);
  }
});

test("session start siempre crea una sesión nueva aunque exista activa", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-create-only-");
  process.chdir(project);

  const existing = createSession("sesion existente para resume");
  assert.ok(existing.id.length > 0);

  const events: BootEvent[] = [];
  const enabledValues: boolean[] = [];

  try {
    await sessionStartCommand("nueva intencion explicita", {
      bootUiFactory: createBootUiSpy(events, enabledValues),
    });

    assert.deepEqual(enabledValues, [false]);
    assert.equal(events.some((event) => event.type === "banner"), true);

    const sessions = listSessions();
    const activeId = getActiveSessionId();

    assert.equal(sessions.length, 2);
    assert.notEqual(activeId, existing.id);
    assert.equal(sessions.find((session) => session.id === activeId)?.intent, "nueva intencion explicita");
  } finally {
    process.chdir(cwd);
  }
});

test("session resume sin id reanuda la sesión activa actual", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-resume-current-");
  process.chdir(project);

  try {
    const current = createSession("sesion actual");

    await sessionResumeCommand();

    assert.equal(getActiveSessionId(), current.id);
  } finally {
    process.chdir(cwd);
  }
});

test("session resume con id carga y marca esa sesión como activa", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-resume-id-");
  process.chdir(project);

  try {
    const first = createSession("primera sesion");
    const second = createSession("segunda sesion");
    setActiveSession(first.id);

    await sessionResumeCommand(second.id);

    assert.equal(getActiveSessionId(), second.id);
  } finally {
    process.chdir(cwd);
  }
});

test("CLI wiring expone session resume [id]", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-cli-resume-");
  process.chdir(project);

  try {
    const first = createSession("primera sesion cli");
    const second = createSession("segunda sesion cli");
    setActiveSession(first.id);

    const result = await runCli(["pipeline", "session", "resume", second.id], project);

    assert.match(result.stdout, new RegExp(`Sesión resumida: ${second.id}`));
    assert.equal(getActiveSessionId(project), second.id);
  } finally {
    process.chdir(cwd);
  }
});

test("CLI session resume con id inexistente sale con error", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-cli-resume-missing-");
  process.chdir(project);

  try {
    await assert.rejects(
      runCli(["pipeline", "session", "resume", "missing-session"], project),
      (err: unknown) => {
        const error = err as { code?: number; stderr?: string };
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /No se pudo reanudar la sesión: missing-session/);
        return true;
      },
    );
  } finally {
    process.chdir(cwd);
  }
});

test("CLI session start ya no acepta --agent", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-cli-start-agent-");
  process.chdir(project);

  try {
    await assert.rejects(
      runCli(["pipeline", "session", "start", "--agent", "codex", "nueva sesion"], project),
      (err: unknown) => {
        const error = err as { code?: number; stderr?: string };
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /unknown option '--agent'/i);
        return true;
      },
    );
  } finally {
    process.chdir(cwd);
  }
});

test("guardia visual boot UI: CI y no-TTY desactivan render", () => {
  const previousCi = process.env.CI;
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: true, stderrIsTty: true, ci: "1" }),
    false,
  );
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: false, stderrIsTty: true, ci: undefined }),
    false,
  );
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: true, stderrIsTty: false, ci: undefined }),
    false,
  );
  try {
    delete process.env.CI;
    assert.equal(
      shouldRenderVisualBootUiForEnv({ stdoutIsTty: true, stderrIsTty: true, ci: undefined }),
      true,
    );
  } finally {
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
  }
});

test("session start error inicialización emite error breve y detiene", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-ui-error-");
  process.chdir(project);

  const events: BootEvent[] = [];
  const enabledValues: boolean[] = [];

  try {
    await assert.rejects(() =>
      sessionStartCommand("x", {
        bootUiFactory: createBootUiSpy(events, enabledValues),
      }),
    );

    assert.deepEqual(enabledValues, [false]);
    const errorIndex = events.findIndex((event) => event.type === "error");
    const stopIndex = events.findIndex((event) => event.type === "stop");

    assert.ok(errorIndex >= 0);
    assert.ok(stopIndex > errorIndex);

    const errorEvent = events[errorIndex] as Extract<BootEvent, { type: "error" }>;
    assert.match(errorEvent.message, /Intención vacía/);
  } finally {
    process.chdir(cwd);
  }
});
