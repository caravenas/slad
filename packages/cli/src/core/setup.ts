import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { input, select } from "@inquirer/prompts";
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

function hasApiKey(provider: "anthropic" | "openai" | "gemini"): boolean {
  switch (provider) {
    case "anthropic": return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    case "openai":    return Boolean(process.env.OPENAI_API_KEY?.trim());
    case "gemini":    return Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
  }
}

function cliIsReady(): boolean {
  const bin = process.env.SLAD_CLI_BINARY?.trim();
  if (!bin) return false;
  // Accept absolute paths or binaries in PATH
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return binaryExists(bin);
}

/** Returns true when at least one provider is ready to use. */
export function providerIsReady(): boolean {
  const provider = process.env.SLAD_DEFAULT_PROVIDER?.trim();
  if (provider === "cli") return cliIsReady();
  if (hasApiKey("anthropic")) return true;
  if (hasApiKey("openai"))    return true;
  if (hasApiKey("gemini"))    return true;
  if (cliIsReady())           return true;
  return false;
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
  console.log(kleur.yellow("  No se encontró un proveedor configurado."));
  console.log(kleur.dim("  Configurá uno para continuar:\n"));

  const choice = await select({
    message: "¿Cómo quieres conectar un modelo?",
    choices: [
      { name: "Ruta a un binario CLI  (codex, claude, gemini…)", value: "cli-path" },
      { name: "API key de Anthropic   (Claude)", value: "anthropic" },
      { name: "API key de OpenAI      (GPT / o-series)", value: "openai" },
      { name: "API key de Google      (Gemini)", value: "gemini" },
    ],
  });

  switch (choice) {
    case "cli-path": {
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
      } else {
        process.env.SLAD_CLI_ARGS = "";
        process.env.SLAD_CLI_PROMPT_MODE = "arg";
        writeConfig({ providers: { defaultProvider: "cli" } });
      }

      console.log(kleur.green(`\n  ✓ Usando ${bin} como proveedor CLI.\n`));
      break;
    }

    case "anthropic": {
      const key = await input({
        message: "ANTHROPIC_API_KEY:",
        validate: (v) => v.trim().startsWith("sk-ant-") ? true : "La key debe empezar con sk-ant-",
      });
      process.env.ANTHROPIC_API_KEY = key.trim();
      process.env.SLAD_DEFAULT_PROVIDER = "anthropic";
      writeConfig({ providers: { defaultProvider: "anthropic" } });
      console.log(kleur.green("\n  ✓ Anthropic configurado. La key se usará solo en esta sesión.\n"));
      console.log(kleur.dim("  Para hacerla permanente, añadila a .env o exportala en tu shell.\n"));
      break;
    }

    case "openai": {
      const key = await input({
        message: "OPENAI_API_KEY:",
        validate: (v) => v.trim().startsWith("sk-") ? true : "La key debe empezar con sk-",
      });
      process.env.OPENAI_API_KEY = key.trim();
      process.env.SLAD_DEFAULT_PROVIDER = "openai";
      writeConfig({ providers: { defaultProvider: "openai" } });
      console.log(kleur.green("\n  ✓ OpenAI configurado. La key se usará solo en esta sesión.\n"));
      console.log(kleur.dim("  Para hacerla permanente, añadila a .env o exportala en tu shell.\n"));
      break;
    }

    case "gemini": {
      const key = await input({ message: "GEMINI_API_KEY (o GOOGLE_API_KEY):" });
      process.env.GEMINI_API_KEY = key.trim();
      process.env.SLAD_DEFAULT_PROVIDER = "gemini";
      writeConfig({ providers: { defaultProvider: "gemini" } });
      console.log(kleur.green("\n  ✓ Gemini configurado. La key se usará solo en esta sesión.\n"));
      console.log(kleur.dim("  Para hacerla permanente, añadila a .env o exportala en tu shell.\n"));
      break;
    }
  }
}
