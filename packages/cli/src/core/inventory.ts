/**
 * Project Inventory — escáner estático del codebase.
 *
 * Genera un resumen estructurado de providers, commands y schemas
 * usando solo `node:fs` + regex. Sin LLM, sin AST parser, sin dependencias externas.
 *
 * Se cachea en memoria por content-hash de `src/` para evitar re-escaneos
 * en la misma sesión.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ProjectInventory,
  InventoryProvider,
  InventoryCommand,
  InventorySchema,
} from "./types.js";

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cachedInventory: { hash: string; value: ProjectInventory } | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Genera (o devuelve desde cache) el inventory del proyecto.
 * @param cwd Raíz del proyecto. Por defecto: process.cwd()
 */
export function generateInventory(cwd?: string): ProjectInventory {
  const root = cwd ?? process.cwd();
  const hash = computeSrcHash(root);

  if (cachedInventory && cachedInventory.hash === hash) {
    return cachedInventory.value;
  }

  const value = scan(root);
  cachedInventory = { hash, value };
  return value;
}

// ─── Content hash ─────────────────────────────────────────────────────────────

function computeSrcHash(root: string): string {
  const srcDirs = [
    path.join(root, "src"),
    path.resolve(root, "..", "shared", "src"),
    path.resolve(root, "..", "model-providers", "src"),
  ].filter((dir) =>
    fs.existsSync(dir),
  );
  if (srcDirs.length === 0) return "no-src";

  const files = srcDirs.flatMap((dir) => collectTsFiles(dir)).sort();
  const h = createHash("sha256");

  for (const file of files) {
    try {
      h.update(fs.readFileSync(file));
    } catch {
      // Ignorar archivos no legibles
    }
  }

  return h.digest("hex").slice(0, 16);
}

function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        result.push(full);
      }
    }
  } catch {
    // dir no accesible
  }
  return result;
}

// ─── Scanner principal ────────────────────────────────────────────────────────

function scan(root: string): ProjectInventory {
  return {
    generatedAt: new Date().toISOString(),
    contentHash: computeSrcHash(root),
    providers: scanProviders(root),
    commands: scanCommands(root),
    schemas: scanSchemas(root),
    cacheSystem: scanCache(root),
    harness: scanHarness(root),
  };
}

// ─── Providers ────────────────────────────────────────────────────────────────

function scanProviders(root: string): InventoryProvider[] {
  const providerModelsDir = path.resolve(root, "..", "model-providers", "src");
  const descriptors = [
    { dir: providerModelsDir, files: ["cli.ts", "retry.ts", "timeout.ts"] },
  ];

  const providers: InventoryProvider[] = [];

  for (const { dir, files } of descriptors) {
    if (!fs.existsSync(dir)) continue;
    for (const fileName of files) {
      const file = path.join(dir, fileName);
      if (!fs.existsSync(file)) continue;

      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }

      const relFile = path.relative(root, file).split(path.sep).join("/");
      const isCli = fileName === "cli.ts";
      const type: "api" | "cli" = isCli ? "cli" : "api";

      const nameMatch =
        content.match(/readonly\s+name\s*:\s*ProviderName\s*=\s*"(\w+)"/) ??
        content.match(/name\s*:\s*ProviderName\s*=\s*"(\w+)"/);
      const name = nameMatch?.[1] ?? fileName.replace(".ts", "");

      const details: string[] = [];
      const sdkMatch =
        content.match(/from\s+["'](@anthropic-ai\/sdk|openai|@google\/generative-ai|@google-cloud\/vertexai)["']/) ??
        content.match(/import\s+\w+\s+from\s+["'](@anthropic-ai\/sdk|openai|@google\/generative-ai)["']/);
      if (sdkMatch) {
        details.push(`SDK: ${sdkMatch[1]}`);
      }

      providers.push({ name, type, file: relFile, details });
    }
  }

  return providers.sort((a, b) => {
    if (a.type !== b.type) return a.type === "api" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function scanCommands(root: string): InventoryCommand[] {
  const commandsDir = path.join(root, "src", "commands");
  if (!fs.existsSync(commandsDir)) return [];

  const commands: InventoryCommand[] = [];

  for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

    const file = path.join(commandsDir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Extraer nombre del command exportado: export function xxxCommand o export async function xxxCommand
    const cmdMatch = content.match(/export\s+(?:async\s+)?function\s+(\w+Command)/);
    if (!cmdMatch) continue;

    const name = cmdMatch[1].replace(/Command$/, "");
    const relFile = `src/commands/${entry.name}`;

    // Detectar HITL
    const hasHitl = content.includes("collectAnswers") || content.includes("awaiting_human");

    // Detectar schemas referenciados en imports desde types
    const typesImportMatch = content.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*types(?:\.js)?["']/);
    const importedTypes = typesImportMatch
      ? typesImportMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    // Identificar inputSchema y outputSchema por convención de nombres
    const outputSchemas = ["ExploreOutput", "SnapshotOutput", "PlanOutput", "RunOutput", "LearnOutput", "EvolveOutput"];
    const foundOutput = importedTypes.find((t) => outputSchemas.includes(t));

    commands.push({
      name,
      file: relFile,
      hasHitl,
      outputSchema: foundOutput,
    });
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

function scanSchemas(root: string): InventorySchema[] {
  const schemaFiles = [
    path.resolve(root, "..", "shared", "src", "schemas.ts"),
    path.join(root, "src", "core", "types.ts"),
  ];

  const byName = new Map<string, InventorySchema>();
  for (const file of schemaFiles) {
    for (const schema of scanSchemaFile(file)) {
      byName.set(schema.name, schema);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scanSchemaFile(file: string): InventorySchema[] {
  if (!fs.existsSync(file)) return [];

  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const schemas: InventorySchema[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Buscar: export const XxxYyy = z.object(
    const schemaMatch = line.match(/^export\s+const\s+([A-Z]\w+)\s*=\s*z\.object\s*\(/);
    if (!schemaMatch) continue;

    const name = schemaMatch[1];
    const fields: string[] = [];

    // Extraer fields del nivel superior leyendo líneas siguientes
    // Buscamos `fieldName:` patterns dentro del object body
    let depth = 0;
    let started = false;

    for (let j = i; j < Math.min(i + 60, lines.length); j++) {
      const l = lines[j];

      for (const ch of l) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
      }

      if (!started && l.includes("z.object(")) {
        started = true;
        continue;
      }

      if (started) {
        // depth === 1 significa que estamos en el nivel superior del object
        if (depth === 1) {
          const fieldMatch = l.match(/^\s{2}(\w+)\s*:/);
          if (fieldMatch) {
            fields.push(fieldMatch[1]);
          }
        }
        // depth vuelve a 0: cerramos el z.object(...)
        if (depth === 0) break;
      }
    }

    schemas.push({ name, fields });
  }

  return schemas;
}

// ─── Cache system ─────────────────────────────────────────────────────────────

function scanCache(root: string): ProjectInventory["cacheSystem"] {
  const cacheDir = path.join(root, "src", "cache");
  const packageCacheDir = path.resolve(root, "..", "cache", "src");
  const enabled = fs.existsSync(cacheDir) || fs.existsSync(packageCacheDir);

  let strategy = "unknown";
  if (enabled) {
    const reusableFile = fs.existsSync(path.join(cacheDir, "reusable.ts"))
      ? path.join(cacheDir, "reusable.ts")
      : path.join(packageCacheDir, "reusable.ts");
    if (fs.existsSync(reusableFile)) {
      try {
        const content = fs.readFileSync(reusableFile, "utf8");
        if (content.includes("content-based") || content.includes("contentHash") || content.includes("content_hash")) {
          strategy = "content-based hash";
        } else if (content.includes("hash")) {
          strategy = "hash-based";
        }
      } catch {
        strategy = "hash-based";
      }
    }
  }

  return { enabled, strategy };
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function scanHarness(root: string): ProjectInventory["harness"] {
  const harnessDir = path.resolve(root, "..", "harness", "src");
  const enabled = fs.existsSync(harnessDir);

  const modes: string[] = [];
  if (enabled) {
    // Buscar modos en harness/types.ts o harness/config.ts
    const candidates = ["types.ts", "config.ts", "index.ts"];
    for (const fname of candidates) {
      const fpath = path.join(harnessDir, fname);
      if (!fs.existsSync(fpath)) continue;
      try {
        const content = fs.readFileSync(fpath, "utf8");
        // Buscar z.enum([...]) o literales de string en enum-like patterns
        for (const m of content.matchAll(/["'](off|on|strict)["']/g)) {
          if (!modes.includes(m[1])) modes.push(m[1]);
        }
      } catch {
        // ignorar
      }
    }

    if (modes.length === 0) {
      // Fallback: los modos estándar del sistema
      modes.push("off", "on", "strict");
    }
  }

  return { enabled, modes };
}
