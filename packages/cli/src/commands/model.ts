import { confirm, input, select } from "@inquirer/prompts";
import kleur from "kleur";
import {
  backendEnvPatch,
  CliBackendId,
  getCliBackend,
  listBackendModels,
  listSupportedBackends,
  resolveBackendBinary,
  serializeBackendSelectionToConfigPatch,
  type BinaryResolution,
} from "../core/backend-registry.js";
import { getGlobalConfigPath, writeGlobalConfigPatch } from "../core/config.js";
import { log } from "../core/logger.js";

type BinaryChoice =
  | { kind: "binary"; resolution: BinaryResolution }
  | { kind: "none" };

function formatProviderLabel(provider: CliBackendId): string {
  return getCliBackend(provider).label;
}

async function chooseProvider(): Promise<CliBackendId> {
  return select<CliBackendId>({
    message: "Proveedor CLI",
    choices: listSupportedBackends().map((backend) => ({
      name: backend.label,
      value: backend.id,
      description: `Usar ${backend.defaultBinary} como agente CLI`,
    })),
  });
}

async function chooseBinary(provider: CliBackendId): Promise<BinaryChoice> {
  const backend = getCliBackend(provider);
  let resolution: BinaryResolution | null = null;

  try {
    const candidate = resolveBackendBinary(provider);
    if (candidate.status === "resolved") resolution = candidate;
  } catch {
    resolution = null;
  }

  if (!resolution?.resolvedPath) {
    console.log("");
    log.warn(`No se encontró un binario ejecutable para ${backend.label}.`);
    return { kind: "none" };
  }

  const choice = await select<"binary" | "none">({
    message: "Binario detectado",
    choices: [
      {
        name: `${resolution.input} (${resolution.resolvedPath})`,
        value: "binary",
        description: "Persistir este binario globalmente.",
      },
      {
        name: "Continuar sin binario",
        value: "none",
        description: "Persistir solo provider + model.",
      },
    ],
  });

  return choice === "binary" ? { kind: "binary", resolution } : { kind: "none" };
}

type ModelChoice = {
  model: string;
  persistBinary: boolean;
};

async function chooseModel(provider: CliBackendId, binaryChoice: BinaryChoice): Promise<ModelChoice> {
  const backend = getCliBackend(provider);

  if (binaryChoice.kind === "binary" && binaryChoice.resolution.resolvedPath) {
    try {
      const modelList = await listBackendModels(provider, { binary: binaryChoice.resolution.resolvedPath });
      const model = await select<string>({
        message: "Modelo",
        choices: modelList.models.map((model) => ({
          name: model.id,
          value: model.id,
          description: `Detectado por ${modelList.sourceCommand}`,
        })),
      });
      return { model, persistBinary: true };
    } catch (err) {
      log.warn((err as Error).message);
      console.log(kleur.dim("  Continuá ingresando el modelo manualmente; se conservará el binario detectado."));
    }
  }

  const defaultModel = backend.id === "claude" ? "sonnet" : undefined;
  const model = await input({
    message: "Modelo",
    default: defaultModel,
    validate: (value) => value.trim().length > 0 || "Ingresá un modelo.",
    transformer: (value) => value.trim(),
  });
  return { model, persistBinary: binaryChoice.kind === "binary" };
}

function printSummary(provider: CliBackendId, model: string, binaryChoice: BinaryChoice): void {
  const configPath = getGlobalConfigPath();
  console.log("");
  console.log(kleur.bold("Resumen"));
  console.log(`  Provider: ${kleur.cyan(formatProviderLabel(provider))}`);
  console.log(`  Model:    ${kleur.cyan(model)}`);
  if (binaryChoice.kind === "binary" && binaryChoice.resolution.resolvedPath) {
    console.log(`  Binary:   ${kleur.cyan(binaryChoice.resolution.resolvedPath)}`);
  } else {
    console.log(`  Binary:   ${kleur.dim("sin binary persistido")}`);
  }
  console.log(`  Alcance:  ${kleur.yellow("global")} (${configPath})`);
  console.log(kleur.dim("  Esta selección se usará por defecto en ejecuciones futuras de este usuario."));
  console.log("");
}

export async function modelCommand(): Promise<void> {
  const provider = await chooseProvider();
  const binaryChoice = await chooseBinary(provider);
  const modelChoice = await chooseModel(provider, binaryChoice);
  const model = modelChoice.model.trim();
  const persistedBinaryChoice =
    modelChoice.persistBinary && binaryChoice.kind === "binary" && binaryChoice.resolution.resolvedPath
      ? binaryChoice
      : ({ kind: "none" } satisfies BinaryChoice);

  printSummary(provider, model, persistedBinaryChoice);

  const shouldSave = await confirm({
    message: "¿Guardar esta selección globalmente?",
    default: true,
  });

  if (!shouldSave) {
    log.warn("No se guardó ningún cambio.");
    return;
  }

  const selection = CliBackendId.parse(provider);
  const binary = persistedBinaryChoice.kind === "binary" ? persistedBinaryChoice.resolution : undefined;
  const patch = serializeBackendSelectionToConfigPatch({ provider: selection, model }, binary);
  writeGlobalConfigPatch(patch);

  Object.assign(process.env, backendEnvPatch(provider, model, binary?.resolvedPath));
  log.success(`Modelo global actualizado en ${getGlobalConfigPath()}.`);
}
