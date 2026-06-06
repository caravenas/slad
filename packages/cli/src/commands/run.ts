
import ora from "ora";
import kleur from "kleur";
import { runSladPipeline } from "@slad/pipeline";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { writeArtifact, readArtifact } from "../persistence/index.js";
import { pathForArtifact } from "../persistence/layout.js";
import { createHitlTransport } from "@slad/hitl";
import { createHarness } from "@slad/harness";
import { loadHarnessConfig } from "../harness/config.js";
import * as prompts from "../agents/prompts.js";
import { getActiveSession, appendArtifact, saveSession } from "../core/session.js";
import type { RunOutput } from "../core/types.js";
import { ProviderError } from "../core/errors.js";

export interface RunOpts {
  input?: string;
  task?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  json?: boolean;
  maxRounds?: number;
  auto?: boolean;
  maxTasks?: number;
  skipSession?: boolean;
  harness?: "off" | "on" | "strict";
  tools?: boolean;
  nonInteractive?: boolean;
  parallel?: boolean;
  maxParallel?: number;
}

export async function runCommand(opts: RunOpts): Promise<void> {
  const cwd = process.cwd();

  const session = opts.skipSession ? null : getActiveSession(cwd);
  const intent = session?.intent ?? "continue plan execution";

  // Load the plan artifact from disk — the run stage needs PlanOutput as input
  let planInput: unknown | undefined;
  if (session) {
    try {
      const planPath = await pathForArtifact("plan", session.id);
      const result = await readArtifact("plan", planPath);
      planInput = result.value;
    } catch {
      log.error("No se encontró un plan para esta sesión. Ejecuta /plan primero.");
      return;
    }
  } else {
    log.error("No hay sesión activa. Ejecuta /auto o /explore primero.");
    return;
  }

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);
  const apiKey = getApiKey(providerName);

  if (providerName !== "cli" && !apiKey) {
    log.error(`No se encontró API key para ${providerName}.`);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getSladProvider(providerName, apiKey ?? undefined);

  if (opts.tools !== false && providerName !== "cli" && !provider.supportsToolUse) {
    throw new ProviderError(
      `El provider "${providerName}" no soporta tool use. No puede ejecutar el run stage.`,
      providerName,
      { retryable: false }
    );
  }

  log.title(`Run · ${providerName}${model ? ` · ${model}` : ""}`);
  console.log("");

  const _hitl = createHitlTransport("tty");
  const harnessConfig = loadHarnessConfig(opts.harness ?? "on");
  const harness = harnessConfig.mode === "off"
    ? undefined
    : await createHarness(harnessConfig);

  let spinner = ora("Iniciando ejecución...").start();

  // Pause the spinner while HITL prompts are active to avoid visual conflicts
  const hitl = {
    kind: _hitl.kind,
    canPrompt: () => _hitl.canPrompt(),
    canInteract: () => _hitl.canInteract(),
    askQuestion: (q: Parameters<typeof _hitl.askQuestion>[0]) => _hitl.askQuestion(q),
    printHeader: _hitl.printHeader?.bind(_hitl),
    printPaused: _hitl.printPaused?.bind(_hitl),
    collectAnswers: async (questions: Parameters<typeof _hitl.collectAnswers>[0]) => {
      if (spinner.isSpinning) spinner.stop();
      const answers = await _hitl.collectAnswers(questions);
      return answers;
    },
  };

  const result = await runSladPipeline({
    intent,
    initialInput: planInput,
    provider,
    model,
    stages: ["run"],
    hitl,
    harness,
    prompts: {
      explorer: prompts.EXPLORER_SYSTEM,
      snapshot: prompts.SNAPSHOT_SYSTEM,
      planner: prompts.PLANNER_SYSTEM,
      builderReviewer: prompts.BUILDER_REVIEWER_SYSTEM
    },
    onStageStart: (stage) => {
      if (spinner.isSpinning) spinner.stop();
      spinner = ora(`Ejecutando ${stage}...`).start();
    },
    onArtifact: async (stage, artifact) => {
      if (stage === "run") {
        // run stage emits RunOutput[] — write each task output individually
        const outputs = Array.isArray(artifact) ? (artifact as RunOutput[]) : [artifact as RunOutput];
        let currentSession = session;
        for (const output of outputs) {
          const ref = await writeArtifact("run", output, { sessionId: currentSession?.id ?? "adhoc" });
          if (currentSession) {
            currentSession = appendArtifact(currentSession, "run", ref.path);
            saveSession(currentSession);
          }
        }
      } else {
        const ref = await writeArtifact(stage as any, artifact as any, { sessionId: session?.id ?? "adhoc" });
        if (session) {
          saveSession(appendArtifact(session, stage as any, ref.path));
        }
      }
    },
    onStageComplete: (stage) => {
      if (spinner.isSpinning) spinner.succeed(`${stage} completado`);
    },
    onTaskStart: (taskId, title) => {
      const text = kleur.dim(taskId) + " " + title;
      if (!spinner.isSpinning) {
        spinner = ora(text).start();
      } else {
        spinner.text = text;
      }
    },
    onTaskComplete: (taskId, status) => {
      const icon = status === "completed" ? kleur.green("✓") : kleur.red("✗");
      spinner.stopAndPersist({ symbol: icon, text: kleur.dim(taskId) + " " + status });
      spinner = ora("").start();
    },
  });

  if (spinner.isSpinning) {
     if (result.status === "failed") spinner.fail("Ejecución falló");
     else spinner.succeed("Ejecución completada");
  }

  if (opts.json) {
    console.log(JSON.stringify(result.outputs["run"], null, 2));
  } else {
    const color = result.status === "completed" ? kleur.green : result.status === "partial" ? kleur.yellow : kleur.red;
    console.log(kleur.bold("Run ") + color(result.status));
  }
}
