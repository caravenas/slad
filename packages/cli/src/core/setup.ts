import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { input } from "@inquirer/prompts";
import kleur from "kleur";

// ─── detection ────────────────────────────────────────────────────────────────

function binaryExists(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cliIsReady(): boolean {
  const bin = process.env.SLAD_CLI_BINARY?.trim();
  if (!bin) return false;
  // Accept absolute paths or binaries in PATH
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return binaryExists(bin);
}

/** Returns true when a CLI agent binary is ready to use. */
export function providerIsReady(): boolean {
  return cliIsReady();
}

// ─── config writer ────────────────────────────────────────────────────────────

function writeConfig(patch: Record<string, unknown>): void {
  const configPath = path.join(process.env.SLAD_WORKSPACE ?? process.cwd(), ".slad-os", "config.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch { /* first run */ }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(deepMerge(existing, patch), null, 2) + "\n");
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof result[k] === "object" && result[k] && !Array.isArray(result[k])) {
      result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ─── setup flow ───────────────────────────────────────────────────────────────

export async function runSetupIfNeeded(): Promise<void> {
  if (providerIsReady()) return;

  console.log("");
  console.log(kleur.yellow("  No se encontró un agente CLI configurado."));
  console.log(kleur.dim("  SLAD delega en un binario de agente (codex, claude, …):\n"));

  const binPath = await input({
    message: "Ruta al binario (ej. codex, /usr/local/bin/codex, claude):",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "Requerido";
      if (path.isAbsolute(trimmed) && !fs.existsSync(trimmed)) return `No encontrado: ${trimmed}`;
      if (!path.isAbsolute(trimmed) && !binaryExists(trimmed)) return `"${trimmed}" no está en el PATH`;
      return true;
    },
  });

  const bin = binPath.trim();
  process.env.SLAD_CLI_BINARY = bin;
  process.env.SLAD_DEFAULT_PROVIDER = "cli";

  // Detect known agents and set their args
  const basename = path.basename(bin).toLowerCase();
  if (basename === "codex") {
    process.env.SLAD_CLI_ARGS = "exec --skip-git-repo-check --sandbox workspace-write --color never";
    process.env.SLAD_CLI_PROMPT_MODE = "stdin";
    writeConfig({ providers: { defaultProvider: "cli", defaultAgent: "codex" } });
  } else if (basename === "claude") {
    process.env.SLAD_CLI_ARGS = "--print";
    process.env.SLAD_CLI_PROMPT_MODE = "arg";
    writeConfig({ providers: { defaultProvider: "cli", defaultAgent: "claude" } });
  } else if (basename === "pi") {
    process.env.SLAD_CLI_ARGS = "--print --no-session";
    process.env.SLAD_CLI_PROMPT_MODE = "arg";
    writeConfig({ providers: { defaultProvider: "cli", defaultAgent: "pi" } });
  } else {
    process.env.SLAD_CLI_ARGS = "";
    process.env.SLAD_CLI_PROMPT_MODE = "arg";
    writeConfig({ providers: { defaultProvider: "cli" } });
  }

  console.log(kleur.green(`\n  ✓ Usando ${bin} como agente CLI.\n`));
}
