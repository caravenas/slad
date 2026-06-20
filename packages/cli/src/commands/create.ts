import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { SladError } from "../core/errors.js";

// ─── Kinds & blueprint mapping ─────────────────────────────────────────────────

export const CREATE_KINDS = ["agent", "tool", "stage", "pipeline", "app"] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];

/** Which top-level blueprints/<dir> holds the templates for each kind. */
const KIND_BLUEPRINT_DIR: Record<CreateKind, string> = {
  agent: "agents",
  app: "agents",
  tool: "tools",
  stage: "stages",
  pipeline: "pipelines",
};

/** Default template id per kind (progressive disclosure — minimal by default). */
const DEFAULT_TEMPLATE: Record<CreateKind, string> = {
  agent: "basic-agent",
  app: "enterprise",
  tool: "shell-tool",
  stage: "llm-stage",
  pipeline: "sequential-pipeline",
};

/** Kinds that scaffold a whole project directory (dest = cwd/<name>). */
const PROJECT_KINDS = new Set<CreateKind>(["agent", "app"]);

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

// ─── Public options & result ───────────────────────────────────────────────────

export interface GenerateOptions {
  template?: string;
  /** Override the working directory (tests). Defaults to process.cwd(). */
  cwd?: string;
  /** Override the blueprints root (tests). Defaults to resolveBlueprintsDir(). */
  blueprintsDir?: string;
}

export interface GenerateResult {
  kind: CreateKind;
  name: string;
  template: string;
  destination: string;
  files: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

export function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

export function toPascal(name: string): string {
  return toKebab(name)
    .split("-")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** Locate the blueprints/ directory: explicit > env > walk up from this module. */
export function resolveBlueprintsDir(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.SLAD_BLUEPRINTS_DIR) candidates.push(process.env.SLAD_BLUEPRINTS_DIR);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "blueprints");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SladError(
    "No se encontró el directorio blueprints/. Define SLAD_BLUEPRINTS_DIR.",
    "BLUEPRINTS_NOT_FOUND",
  );
}

function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in vars ? vars[key] : match,
  );
}

function copyTree(
  srcDir: string,
  destDir: string,
  vars: Record<string, string>,
  written: string[],
): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, substitute(entry.name, vars));
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyTree(srcPath, destPath, vars, written);
      continue;
    }
    if (fs.existsSync(destPath)) {
      throw new SladError(`El archivo ya existe: ${destPath}`, "CREATE_TARGET_EXISTS");
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, substitute(fs.readFileSync(srcPath, "utf8"), vars));
    written.push(destPath);
  }
}

// ─── Core generator (pure, testable) ───────────────────────────────────────────

export function generate(
  kind: CreateKind,
  name: string,
  options: GenerateOptions = {},
): GenerateResult {
  if (!NAME_RE.test(name)) {
    throw new SladError(
      `Nombre inválido: "${name}". Usa letras, números, guiones y guiones bajos (debe empezar con letra).`,
      "CREATE_INVALID_NAME",
    );
  }

  const template = options.template ?? DEFAULT_TEMPLATE[kind];
  const blueprintsDir = resolveBlueprintsDir(options.blueprintsDir);
  const blueprintDir = path.join(blueprintsDir, KIND_BLUEPRINT_DIR[kind], template);
  if (!fs.existsSync(blueprintDir)) {
    throw new SladError(
      `Blueprint no encontrado: ${KIND_BLUEPRINT_DIR[kind]}/${template}`,
      "CREATE_TEMPLATE_NOT_FOUND",
      { blueprintDir },
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const destRoot = PROJECT_KINDS.has(kind) ? path.join(cwd, name) : cwd;
  if (PROJECT_KINDS.has(kind) && fs.existsSync(destRoot)) {
    throw new SladError(`El directorio ya existe: ${destRoot}`, "CREATE_TARGET_EXISTS");
  }
  fs.mkdirSync(destRoot, { recursive: true });

  const vars: Record<string, string> = {
    name,
    id: toKebab(name),
    Name: toPascal(name),
  };

  const files: string[] = [];
  copyTree(blueprintDir, destRoot, vars, files);
  return { kind, name, template, destination: destRoot, files };
}

// ─── CLI command ────────────────────────────────────────────────────────────────

export interface CreateCommandOptions {
  template?: string;
}

export async function createCommand(
  kindArg: string,
  name: string,
  opts: CreateCommandOptions = {},
): Promise<void> {
  if (!(CREATE_KINDS as readonly string[]).includes(kindArg)) {
    throw new SladError(
      `Tipo inválido: "${kindArg}". Usa uno de: ${CREATE_KINDS.join(" | ")}.`,
      "CREATE_INVALID_KIND",
    );
  }
  const kind = kindArg as CreateKind;

  const result = generate(kind, name, { template: opts.template });

  const rel = path.relative(process.cwd(), result.destination) || ".";
  process.stdout.write(
    `\n${kleur.green("✓")} Generado ${kleur.bold(kind)} ${kleur.cyan(name)} ` +
      `${kleur.dim(`(template: ${result.template})`)}\n`,
  );
  process.stdout.write(`  ${kleur.dim("→")} ${rel}\n`);
  for (const f of result.files) {
    process.stdout.write(`    ${kleur.dim("+")} ${path.relative(result.destination, f) || path.basename(f)}\n`);
  }
  if (PROJECT_KINDS.has(kind)) {
    process.stdout.write(
      `\n  ${kleur.dim("Próximos pasos:")}\n` +
        `    cd ${rel} && pnpm install && pnpm start\n`,
    );
  }
}

// ─── Blueprint discovery (`slad create --list`) ─────────────────────────────────

/** Which create kinds consume each top-level blueprints/<dir>. */
const BLUEPRINT_DIR_KINDS: Record<string, CreateKind[]> = {
  agents: ["agent", "app"],
  tools: ["tool"],
  stages: ["stage"],
  pipelines: ["pipeline"],
};

/** List the available blueprint directories and their templates to stdout. */
export function listBlueprints(blueprintsDirOverride?: string): void {
  const root = resolveBlueprintsDir(blueprintsDirOverride);
  process.stdout.write(
    `\n${kleur.bold("Blueprints disponibles")} ${kleur.dim(`(${root})`)}\n`,
  );

  for (const [dir, kinds] of Object.entries(BLUEPRINT_DIR_KINDS)) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) continue;

    const templates = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (templates.length === 0) continue;

    const verbs = kinds.map((k) => `slad create ${k}`).join(" | ");
    process.stdout.write(`\n  ${kleur.cyan(dir)} ${kleur.dim(`(${verbs})`)}\n`);
    for (const template of templates) {
      const defaultFor = kinds.filter((k) => DEFAULT_TEMPLATE[k] === template);
      const tag = defaultFor.length > 0 ? kleur.dim(` — default: ${defaultFor.join(", ")}`) : "";
      process.stdout.write(`    ${kleur.dim("·")} ${template}${tag}\n`);
    }
  }
  process.stdout.write("\n");
}
