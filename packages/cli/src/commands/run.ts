
import ora from "ora";
import kleur from "kleur";
import { runSladPipeline } from "@slad/pipeline";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { writeArtifact } from "../persistence/index.js";
import { createHitlTransport } from "@slad/hitl";
import { createHarness } from "@slad/harness";
import { loadHarnessConfig } from "../harness/config.js";
import * as prompts from "../agents/prompts.js";
import { getActiveSession } from "../core/session.js";
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
  
  // To run the `run` stage, we just need the intent and the plan output. 
  // Normally the pipeline requires `intent`, so let's try to get it from the session.
  const session = opts.skipSession ? null : getActiveSession(cwd);
  const intent = session?.intent ?? "continue plan execution";

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

  const hitl = createHitlTransport("tty", );
  const harnessConfig = loadHarnessConfig(opts.harness ?? "on");
  const harness = harnessConfig.mode === "off" 
    ? undefined 
    : await createHarness(harnessConfig);

  let spinner = ora("Iniciando ejecución...").start();

  const result = await runSladPipeline({
    intent,
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
      if (stage !== "run") {
        await writeArtifact(stage as any, artifact as any, { sessionId: session?.id ?? "adhoc" });
      }
    },
    onStageComplete: (stage) => {
       if (spinner.isSpinning) spinner.succeed(`${stage} completado`);
    }
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
