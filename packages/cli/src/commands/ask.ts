import ora from "ora";
import kleur from "kleur";
import { getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { getActiveSession, saveSession } from "../core/session.js";
import { appendAgentRunLog } from "../persistence/telemetry.js";

const ASK_SYSTEM = `Eres un asistente técnico de SLAD OS.
Responde en lenguaje natural — no uses JSON.
Sé directo, conciso y útil. Evita relleno y hedging.
Si la pregunta implica implementar código, tomar decisiones de arquitectura o requiere
trazabilidad, sugiere usar \`slad auto "<intent>"\` al final de tu respuesta.`;

export interface AskOpts {
  provider?: string;
  agent?: string;
  model?: string;
  save?: boolean;
}

export async function askCommand(intent: string, opts: AskOpts): Promise<void> {
  if (!intent || intent.trim().length < 2) {
    log.error('Pregunta vacía. Uso: slad ask "<tu pregunta>"');
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);


  const model = opts.model ?? getModel(providerName);
  const provider = await getSladProvider(providerName);

  const spinner = ora("Pensando...").start();

  let response: string;
  try {
    response = await provider.complete([{ role: "user", content: intent }], {
      systemPrompt: ASK_SYSTEM,
      temperature: 0.7,
      maxTokens: 1024,
      model,
    });
  } catch (err) {
    spinner.fail("Error al consultar el modelo");
    log.error((err as Error).message);
    process.exit(1);
  }

  spinner.stop();
  console.log("");
  console.log(kleur.bold().white(response));
  console.log("");

  const session = getActiveSession();

  if (opts.save) {
    if (session) {
      const note = `[ask] ${intent.slice(0, 80)}\n${response.slice(0, 400)}`;
      saveSession({ ...session, notes: [...session.notes, note] });
      log.dim(`  guardado en sesión ${session.id}`);
    } else {
      log.warn("  --save ignorado: no hay sesión activa (usá `slad session start` primero)");
    }
  }

  await appendAgentRunLog({
    sessionId: session?.id ?? "",
    intent,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    commandUsed: "ask",
    model,
    provider: providerName,
    pipelineStatus: "completed",
    stagesCompleted: [],
    debateUsed: false,
  });
}
