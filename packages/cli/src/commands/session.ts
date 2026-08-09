import kleur from "kleur";
import {
  createSession,
  getActiveSession,
  getActiveSessionId,
  listSessions,
  loadSession,
  resumeSession,
  setActiveSession,
} from "../core/session.js";
import { log } from "../core/logger.js";
import { SladError } from "../core/errors.js";
import { createBootUi, type BootUiOptions } from "../cli/ui.js";

type SessionStartDeps = {
  bootUiFactory?: (opts: BootUiOptions) => ReturnType<typeof createBootUi>;
};

export function shouldRenderVisualBootUiForEnv(opts?: {
  stdoutIsTty?: boolean;
  stderrIsTty?: boolean;
  ci?: string | undefined;
}): boolean {
  const stdoutIsTty = opts?.stdoutIsTty ?? process.stdout.isTTY;
  const stderrIsTty = opts?.stderrIsTty ?? process.stderr.isTTY;
  const ci = opts?.ci ?? process.env.CI;
  return Boolean(stdoutIsTty && stderrIsTty && ci === undefined);
}

function shouldRenderVisualBootUi(): boolean {
  return shouldRenderVisualBootUiForEnv();
}

export async function sessionStartCommand(
  intent: string,
  deps: SessionStartDeps = {},
): Promise<void> {
  const bootUiFactory = deps.bootUiFactory ?? createBootUi;
  const bootUi = bootUiFactory({ enabled: shouldRenderVisualBootUi() });

  try {
    await bootUi.showBanner();
    bootUi.start("Iniciando sesión...");
    if (!intent || intent.trim().length < 3) {
      throw new SladError(
        'Intención vacía. Uso: slad session start "<intención>"',
        "SESSION_START_INVALID_INTENT",
      );
    }

    bootUi.milestone("config", "Creando estado base de sesión...");
    bootUi.milestone("persistence", "Persistiendo estado de sesión...");
    const session = createSession(intent.trim());

    bootUi.succeed(`Sesión creada: ${session.id}`);
    log.dim(`  intent: ${session.intent}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error iniciando sesión";
    await bootUi.fail(message);
    throw error;
  }
}

export async function sessionResumeCommand(id?: string): Promise<void> {
  const session = resumeSession(id);
  if (!session) {
    const suffix = id ? `: ${id}` : "";
    throw new SladError(`No se pudo reanudar la sesión${suffix}.`, "SESSION_RESUME_FAILED");
  }

  log.success(`Sesión resumida: ${session.id}`);
  log.dim(`  intent: ${session.intent}`);
}

export async function sessionListCommand(): Promise<void> {
  const sessions = listSessions();
  const activeId = getActiveSessionId();

  if (sessions.length === 0) {
    log.dim("No hay sesiones. Creá una con: slad session start \"<intención>\"");
    return;
  }

  console.log("");
  sessions.forEach((s) => {
    const active = s.id === activeId ? kleur.green(" ← activa") : "";
    const phase = s.currentPhase ? kleur.dim(` [${s.currentPhase}]`) : "";
    const artifacts = s.artifacts.length ? kleur.dim(` · ${s.artifacts.length} artefactos`) : "";
    console.log(kleur.bold(s.id) + active + phase + artifacts);
    console.log(kleur.dim(`  ${s.intent}`));
    console.log("");
  });
}

export async function sessionUseCommand(id: string): Promise<void> {
  const session = loadSession(id);
  if (!session) {
    log.error(`No existe la sesión: ${id}`);
    process.exit(1);
  }
  setActiveSession(id);
  log.success(`Sesión activa: ${id}`);
}

export async function sessionShowCommand(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    log.dim("No hay sesión activa. Creá una con: slad session start \"<intención>\"");
    return;
  }

  console.log("");
  console.log(kleur.bold("Sesión activa"));
  console.log("  " + kleur.cyan(session.id));

  console.log("\n" + kleur.bold("Intent"));
  console.log("  " + session.intent);

  if (session.currentPhase) {
    console.log("\n" + kleur.bold("Fase actual"));
    console.log("  " + session.currentPhase);
  }

  if (session.artifacts.length) {
    console.log("\n" + kleur.bold("Artefactos"));
    session.artifacts.forEach((a) => {
      const taskSuffix = a.taskId ? kleur.dim(` (${a.taskId})`) : "";
      console.log(`  · ${kleur.cyan(a.kind)}${taskSuffix} → ${a.path}`);
    });
  } else {
    console.log("\n" + kleur.dim("  Sin artefactos todavía."));
  }

  if (session.humanAnswers.length) {
    console.log("\n" + kleur.bold("Decisiones HITL"));
    session.humanAnswers.forEach((a) => {
      console.log(`  · [${a.taskId}/${a.questionId}] ${kleur.green(a.answer)}`);
    });
  }
}
