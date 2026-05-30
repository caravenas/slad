import fs from "node:fs";

import ora from "ora";
import { runSladPipeline } from "@slad/pipeline";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getSladProvider } from "../core/providers.js";
import { log } from "../core/logger.js";
import { readArtifact, writeArtifact, listArtifacts } from "../persistence/index.js";
import { createHitlTransport } from "@slad/hitl";
import * as prompts from "../agents/prompts.js";
import { getActiveSession } from "../core/session.js";
import type { SessionState, RunOutput } from "../core/types.js";

export interface LearnOpts {
  input?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  json?: boolean;
  skipSession?: boolean;
  cwd?: string;
}



async function readRun(input: string | undefined): Promise<{ source: string; content: RunOutput }> {
  // simplificado por ahora, idealmente leer de session o artefactos recientes
  let runPath = input;
  if (!runPath) {
    const refs = await listArtifacts("run");
    runPath = refs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((ref) => fs.existsSync(ref.path))?.path;
  }

  if (!runPath || !fs.existsSync(runPath)) {
    throw new Error("No existe un run report. Usa --input <run.md|run.json> o corre `slad run` primero.");
  }

  const { value } = await readArtifact("run", runPath);
  return { source: runPath, content: value };
}

async function readSessionRuns(session: SessionState, ): Promise<Array<{ source: string; content: RunOutput }>> {
  const runArtifacts = session.artifacts.filter((artifact) => artifact.kind === "run");
  if (runArtifacts.length === 0) {
    throw new Error("La sesión activa no tiene artifacts run. Corre `slad run` primero.");
  }

  const runs: Array<{ source: string; content: RunOutput }> = [];
  for (const artifact of runArtifacts) {
    const { value } = await readArtifact("run", artifact.path);
    runs.push({ source: artifact.path, content: value });
  }
  return runs;
}

export async function learnCommand(opts: LearnOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const session = opts.skipSession ? null : getActiveSession(cwd);

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider, config.defaultAgent);
  const apiKey = getApiKey(providerName);

  if (providerName !== "cli" && !apiKey) {
    log.error(`No se encontró API key para ${providerName}.`);
    process.exit(1);
  }

  let runs: Array<{ source: string; content: RunOutput }>;
  try {
    runs = !opts.input && session
      ? await readSessionRuns(session)
      : [await readRun(opts.input)];
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getSladProvider(providerName, apiKey ?? undefined);

  log.title(`Learn · ${providerName}${model ? ` · ${model}` : ""}`);
  console.log("");

  const hitl = createHitlTransport("tty", );
  let spinner = ora("Iniciando extracción de aprendizajes...").start();

  const result = await runSladPipeline({
    provider,
    model,
    stages: ["learn"],
    hitl,
    initialInput: runs.map(r => r.content),
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
      await writeArtifact(stage as any, artifact as any, { sessionId: session?.id ?? "adhoc" });
    },
    onStageComplete: (stage) => {
       if (spinner.isSpinning) spinner.succeed(`${stage} completado`);
    }
  });

  if (spinner.isSpinning) {
     if (result.status === "failed") spinner.fail("Learn falló");
     else spinner.succeed("Learn completado");
  }

  if (opts.json) {
    console.log(JSON.stringify(result.outputs["learn"], null, 2));
  }
}
