# SLAD OS v0.2 — Plan de Implementacion

> Documento de spec para implementar con Sonnet en sesiones futuras.
> Cada seccion es autocontenida: tiene contexto, archivos a crear/modificar, interfaces, y criterios de done.

---

## Pieza 1: ExecutionHarness

### Contexto

El proposal completo esta en `docs/execution-harness-proposal.md`. Las interfaces y el clasificador ya estan diseñados. Lo que falta es la implementacion real, la integracion con `run.ts`, y el flag CLI.

El harness es middleware opt-in entre Planner y Builder. Modos: `off` (default), `on`, `strict`.

### Archivos a crear

#### 1.1 `src/harness/types.ts`

Copiar textualmente las interfaces de `docs/execution-harness-proposal.md` seccion 2 (lineas 20-108). Incluye:

- `PermissionLevel` (Zod enum: "read" | "workspace" | "full")
- `CommandClassification` (Zod object)
- `HookVerdict` (union type: allow | deny | modify)
- `PreTaskHook` / `PostTaskHook` interfaces
- `PreTaskContext` / `PostTaskContext` interfaces
- `HarnessMode` (Zod enum: "off" | "on" | "strict")
- `HarnessConfig` (Zod object con defaults)

**Importante:** Los imports deben referenciar `../core/types.js` para `PlanTask`, `RunOutput`, `ChatMessage`.

#### 1.2 `src/harness/classifier.ts`

Copiar de la seccion 3 del proposal (lineas 142-193). Exporta:

- `DANGEROUS_PATTERNS` — array de `{ pattern: RegExp, level, reason }`
- `classifyCommand(command: string): CommandClassification`
- `classifyRunOutput(output: RunOutput): CommandClassification[]` — itera sobre `output.verification.map(v => v.command)`
- `highestLevel(classifications): PermissionLevel`

**Ajuste necesario:** La funcion `classifyRunOutput` del proposal asume que `verification` tiene un campo `command`. Verificar el schema real en `types.ts` linea 106-119:

```typescript
verification: z.array(z.object({
  command: z.string(),
  status: z.string().transform(...),
  notes: z.string().default(""),
}))
```

Si, `command` existe. La implementacion del proposal es correcta.

#### 1.3 `src/harness/audit.ts`

Copiar de la seccion 4 del proposal (lineas 198-248). Exporta:

- `AuditEventKind` type
- `AuditEvent` interface
- `AuditLogger` class con: `constructor(logPath)`, `log(event)`, `flush()`

**Ajuste necesario:** Agregar `import path from "node:path"` — el proposal lo omite pero lo usa en `ensureOpen()`.

#### 1.4 `src/harness/approval.ts`

Copiar de la seccion 6 del proposal (lineas 386-411). Exporta:

- `confirmDangerousAction(taskId, classifications): Promise<boolean>`

Usa `@inquirer/prompts` (ya es dependencia del proyecto) y `kleur`.

#### 1.5 `src/harness/config.ts`

**Archivo nuevo, no esta en el proposal.** Necesario para:

```typescript
// src/harness/config.ts
import fs from "node:fs";
import path from "node:path";
import { HarnessConfig, HarnessMode } from "./types.js";

const CONFIG_PATH = ".slad-os/harness.json";

export function loadHarnessConfig(
  modeOverride: HarnessMode,
  cwd = process.cwd(),
): HarnessConfig {
  const configPath = path.join(cwd, CONFIG_PATH);
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      // config invalido, usar defaults
    }
  }

  return HarnessConfig.parse({
    ...fileConfig,
    mode: modeOverride, // CLI flag siempre gana
  });
}
```

#### 1.6 `src/harness/index.ts`

Implementacion de la interfaz `ExecutionHarness`. Este archivo **no esta completo en el proposal** — el proposal solo define la interfaz (seccion 2.4, lineas 114-133). Hay que implementarla:

```typescript
// src/harness/index.ts
import type { PlanTask, RunOutput } from "../core/types.js";
import type { ExecutionHarness } from "./types.js"; // mover la interfaz a types
import { HarnessConfig, type CommandClassification, type HookVerdict } from "./types.js";
import { classifyRunOutput, highestLevel } from "./classifier.js";
import { AuditLogger } from "./audit.js";
import { confirmDangerousAction } from "./approval.js";

export async function createHarness(config: HarnessConfig): Promise<ExecutionHarness> {
  const audit = config.auditLog ? new AuditLogger(config.auditLogPath) : null;

  // Cargar hooks dinamicos (ESM imports)
  const preHooks = await loadHooks<PreTaskHook>(config.preTaskHooks);
  const postHooks = await loadHooks<PostTaskHook>(config.postTaskHooks);

  return {
    config,

    async beforeTask(task: PlanTask, sessionId: string | null): Promise<HookVerdict> {
      audit?.log({
        timestamp: new Date().toISOString(),
        sessionId,
        taskId: task.id,
        kind: "task_start",
        data: { title: task.title, files: task.files },
      });

      // Ejecutar pre-hooks en orden. El primero que deniegue gana.
      for (const hook of preHooks) {
        const verdict = await hook.execute({
          task,
          sessionId,
          permissionLevel: config.maxPermission,
          sessionPermissions: config.maxPermission,
        });

        audit?.log({
          timestamp: new Date().toISOString(),
          sessionId,
          taskId: task.id,
          kind: "hook_verdict",
          data: { hook: hook.name, verdict },
        });

        if (verdict.action !== "allow") return verdict;
      }

      return { action: "allow" };
    },

    classifyOutput(output: RunOutput): CommandClassification[] {
      return classifyRunOutput(output);
    },

    requiresApproval(classifications: CommandClassification[]): boolean {
      if (config.mode === "off") return false;
      const highest = highestLevel(classifications);

      // En strict: workspace y full requieren approval
      // En on: solo full requiere approval
      if (config.mode === "strict") return highest !== "read";
      return highest === "full";
    },

    async afterTask(task: PlanTask, output: RunOutput, durationMs: number): Promise<void> {
      const classifications = classifyRunOutput(output);

      for (const c of classifications) {
        audit?.log({
          timestamp: new Date().toISOString(),
          sessionId: null,
          taskId: task.id,
          kind: "command_classified",
          data: c,
        });
      }

      audit?.log({
        timestamp: new Date().toISOString(),
        sessionId: null,
        taskId: task.id,
        kind: "task_end",
        data: {
          status: output.status,
          durationMs,
          changedFiles: output.changedFiles,
        },
      });

      // Ejecutar post-hooks (no bloquean)
      for (const hook of postHooks) {
        await hook.execute({
          task,
          output,
          classifications,
          durationMs,
          changedFiles: output.changedFiles,
        });
      }
    },

    async flush(): Promise<void> {
      await audit?.flush();
    },
  };
}

async function loadHooks<T>(paths: string[]): Promise<T[]> {
  const hooks: T[] = [];
  for (const p of paths) {
    try {
      const mod = await import(path.resolve(p));
      hooks.push(mod.default);
    } catch (err) {
      console.warn(`Warning: no se pudo cargar hook ${p}: ${(err as Error).message}`);
    }
  }
  return hooks;
}
```

### Archivos a modificar

#### 1.7 `src/core/types.ts` — agregar status "blocked" al RunOutput

Linea 102, cambiar:

```typescript
// ANTES
status: z.enum(["completed", "blocked", "failed", "awaiting_human"]),

// DESPUES — no cambia, "blocked" ya existe! Verificado.
```

No hay cambios necesarios en types.ts. El status "blocked" ya esta soportado.

#### 1.8 `src/commands/run.ts` — integracion del harness

**Cambio 1: Imports** (agregar al top del archivo)

```typescript
import { createHarness } from "../harness/index.js";
import { loadHarnessConfig } from "../harness/config.js";
import type { ExecutionHarness } from "../harness/types.js";
```

**Cambio 2: RunOpts** (linea 25-37, agregar campo)

```typescript
export interface RunOpts {
  // ... campos existentes ...
  harness?: "off" | "on" | "strict";  // nuevo
}
```

**Cambio 3: executeTask** (linea 163, agregar parametro)

Agregar `harness: ExecutionHarness | null` como ultimo parametro. Implementar pre-task check y post-task audit segun seccion 5.1 del proposal (lineas 269-343).

Puntos de insercion exactos:

1. **Despues de linea 176** (antes del while loop): insertar pre-task verdict check
2. **Despues de linea 235** (despues del while loop, antes de escribir archivo): insertar post-task classify + approval
3. **Antes del return** (linea 243): insertar `harness.afterTask()`

**Cambio 4: runAutoLoop** (linea 318, agregar parametro)

Agregar `harness: ExecutionHarness | null` como ultimo parametro. Pasarlo a `executeTask()` en linea 397.

**Cambio 5: runCommand** (linea 565)

Inicializar harness despues de cargar config:

```typescript
const harnessMode = opts.harness ?? "off";
const harness = harnessMode !== "off"
  ? await createHarness(loadHarnessConfig(harnessMode as HarnessMode))
  : null;
```

Wrap en try/finally con `harness?.flush()`.

Pasar `harness` a `runAutoLoop()` y `executeTask()`.

#### 1.9 `src/cli.ts` — agregar flag --harness

En el comando `run` (linea 71-88), agregar option:

```typescript
.option("--harness <mode>", "Modo del arnés de seguridad (off | on | strict)", "off")
```

### Tests a crear

#### 1.10 `src/harness/classifier.test.ts`

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, highestLevel } from "./classifier.js";

describe("classifyCommand", () => {
  it("clasifica rm -rf como full", () => {
    const result = classifyCommand("rm -rf /tmp/something");
    assert.equal(result.level, "full");
  });

  it("clasifica sudo como full", () => {
    const result = classifyCommand("sudo apt install something");
    assert.equal(result.level, "full");
  });

  it("clasifica git push --force como full", () => {
    const result = classifyCommand("git push origin main --force");
    assert.equal(result.level, "full");
  });

  it("clasifica npm install como workspace", () => {
    const result = classifyCommand("npm install express");
    assert.equal(result.level, "workspace");
  });

  it("clasifica git commit como workspace", () => {
    const result = classifyCommand("git commit -m 'fix'");
    assert.equal(result.level, "workspace");
  });

  it("clasifica cat como read", () => {
    const result = classifyCommand("cat file.txt");
    assert.equal(result.level, "read");
  });

  it("clasifica ls como read", () => {
    const result = classifyCommand("ls -la");
    assert.equal(result.level, "read");
  });
});

describe("highestLevel", () => {
  it("retorna full si hay al menos uno full", () => {
    const classifications = [
      { original: "ls", level: "read" as const, reason: "", patterns: [] },
      { original: "rm -rf /", level: "full" as const, reason: "", patterns: [] },
    ];
    assert.equal(highestLevel(classifications), "full");
  });

  it("retorna read si todos son read", () => {
    const classifications = [
      { original: "ls", level: "read" as const, reason: "", patterns: [] },
    ];
    assert.equal(highestLevel(classifications), "read");
  });
});
```

#### 1.11 `src/harness/audit.test.ts`

Test que verifica:
- Crea archivo si no existe
- Append-only (multiples logs no sobreescriben)
- Flush cierra el fd
- Formato LDJSON valido (cada linea es JSON parseable)

Usar `fs.mkdtempSync` para directorio temporal.

### Criterios de done

- [ ] `slad run T1 --harness=on` ejecuta con el arnés activo
- [ ] `slad run --auto --harness=strict` pide aprobacion en comandos full
- [ ] `slad run T1` (sin flag) funciona identico a como funciona hoy
- [ ] Audit log se crea en `.slad-os/audit.ldjson`
- [ ] Tests del classifier pasan
- [ ] Tests del audit logger pasan

---

## Pieza 2: CLAUDE.md + AGENTS.md

### Contexto

SLAD OS no tiene `CLAUDE.md` ni `AGENTS.md` en el repo. `AGENTS.md` es critico porque el sistema lo lee en `src/core/context.ts` (linea 4: `const CONTEXT_FILE = "AGENTS.md"`) y lo inyecta como contexto a todos los agentes. Sin este archivo, `projectContextBlock()` retorna string vacio.

`CLAUDE.md` es para que agentes externos (Claude Code, Cursor, etc.) entiendan el proyecto rapidamente.

### Archivos a crear

#### 2.1 `CLAUDE.md`

Contenido que debe cubrir:

```markdown
# SLAD OS

## Que es

CLI orchestrator para AI agents en software development.
Pipeline: explore -> snapshot -> plan -> run -> learn -> evolve.
Cada stage produce JSON validado por Zod que el siguiente consume.

## Stack

- TypeScript 5.6 + Node.js (ESM)
- Zod para schemas
- Commander para CLI
- @inquirer/prompts para HITL
- kleur + ora para output

## Estructura del proyecto

src/
  cli.ts              # Entry point (Commander)
  commands/            # Un archivo por stage del pipeline + chat + session
  agents/
    prompts.ts         # System prompts de todos los agentes
    explorer.ts        # Wiki context caching para explore
  core/
    types.ts           # Todos los Zod schemas (ExploreOutput, PlanTask, RunOutput, etc.)
    config.ts          # .env loading, provider/model resolution
    session.ts         # SessionState CRUD
    hitl.ts            # Question collection + answer formatting
    logger.ts          # Thin wrapper sobre console con colores
    context.ts         # Lee AGENTS.md y lo inyecta como contexto
  models/
    index.ts           # ModelProvider interface + factory
    anthropic.ts       # Anthropic SDK
    openai.ts          # OpenAI SDK
    gemini.ts          # Google Generative AI SDK
    cli.ts             # Local binary (codex/claude) via subprocess
  cache/
    reusable.ts        # High-level cache API (readOrCreateReusableValue)
    store.ts           # Filesystem cache store (~/.slad-os/cache/v1)
    invalidation.ts    # Content-based invalidation rules
    keys.ts            # Cache key generation
  project/
    project-id.ts      # Deterministic project identity

## Convenciones

- Schemas Zod en core/types.ts, no dispersos
- Prompts como string constants en agents/prompts.ts
- Cada comando exporta una funcion <name>Command(opts) y un interface <Name>Opts
- Tests con node:test (no jest, no vitest)
- Espanol en UI/prompts del CLI, ingles en codigo
- process.exit(1) para errores fatales en commands
- JSON extraction de LLM responses via extractJson() (fence-aware)

## Comandos utiles

npm run dev -- explore "tu intencion"    # Run sin compilar
npm run build                            # Compila a dist/
npm test                                 # Corre todos los .test.ts
npm run dev -- chat                      # REPL interactivo

## Cosas a tener en cuenta

- ModelProvider es la abstraccion central. Nunca llamar SDKs directamente desde commands.
- SessionState trackea artefactos entre stages. Siempre appendArtifact() despues de generar output.
- El cache es content-based (hash de inputs). No usar timestamps.
- HITL: los agentes pueden retornar status "awaiting_human" + questions[]. El loop en el command se encarga.
- RunOutput.verification[].command es lo que el clasificador del harness analiza.
```

**Ajustar** segun el estado real del proyecto al momento de implementar (por ejemplo, si el harness ya esta implementado, mencionarlo).

#### 2.2 `AGENTS.md`

Este archivo es el que `src/core/context.ts` inyecta a los agentes LLM. Debe ser conciso (max 8000 chars, ver linea 5 de context.ts) y orientado a que el LLM entienda el proyecto:

```markdown
# SLAD OS — Project Context

## Architecture

SLAD OS is a CLI-based AI agent orchestrator for structured software development.
Pipeline: explore -> snapshot -> plan -> run (xN) -> learn -> evolve.

Each stage produces typed JSON artifacts validated by Zod schemas.
Artifacts are tracked in SessionState and persist across commands.

## Key Files

- src/core/types.ts — All Zod schemas (ExploreOutput, PlanTask, RunOutput, etc.)
- src/agents/prompts.ts — System prompts for all agents
- src/models/index.ts — ModelProvider interface (vendor abstraction)
- src/core/session.ts — Session state CRUD
- src/core/hitl.ts — Human-in-the-loop question/answer system

## Code Style

- TypeScript ESM (import from ".js" extensions)
- Functional style, minimal classes
- Error handling: throw with descriptive messages, caller decides exit behavior
- All agent outputs must pass their Zod schema (safeParse + clear error on failure)
- JSON extraction from LLM responses: extractJson() handles markdown fences

## Task Format

Tasks follow the PlanTask schema:
- id: T1, T2, T3...
- dependsOn: array of task ids (DAG)
- files: array of file paths this task touches
- acceptanceCriteria: what "done" means

## Builder Expectations

When executing a task in the Run phase:
- Produce a RunOutput JSON with taskId, status, summary, changedFiles, verification
- Use verification[].command to describe what commands validate the work
- If blocked, set status "awaiting_human" and populate questions[]
- Changed files should be relative paths from project root

## Project Patterns

- Provider-agnostic: never reference a specific LLM vendor in business logic
- Cache by content hash, not timestamps
- HITL answers accumulate in session — don't re-ask resolved questions
- Logs and audit are append-only
```

### Criterios de done

- [ ] `CLAUDE.md` existe en la raiz del proyecto
- [ ] `AGENTS.md` existe en la raiz del proyecto
- [ ] `projectContextBlock()` retorna contenido no vacio cuando se llama
- [ ] El contenido de AGENTS.md es < 8000 caracteres

---

## Pieza 3: Error Handling + Logging

### Contexto

Actualmente:
- **Logger** (`src/core/logger.ts`): 10 lineas, wrapper thin sobre `console.log` con colores. No tiene: niveles configurables, timestamps, output a archivo, contexto estructurado.
- **Error handling**: Los commands hacen `try/catch` → `log.error()` → `process.exit(1)`. No hay:
  - Clases de error tipadas (no se puede distinguir provider error de schema error de file error)
  - Recovery (si un provider falla por rate limit, se muere en vez de reintentar)
  - Error context (stack traces se pierden, no se sabe en que stage/task ocurrio)

### Archivos a crear

#### 3.1 `src/core/errors.ts` — Error classes tipadas

```typescript
// src/core/errors.ts

/**
 * Base error para SLAD OS. Todas las clases custom heredan de esta.
 * Permite catch granular y reportes con contexto.
 */
export class SladError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "SladError";
    this.code = code;
    this.context = context;
  }
}

/**
 * Error de comunicacion con el provider LLM.
 * Incluye provider name, status code si aplica, y si es retryable.
 */
export class ProviderError extends SladError {
  readonly provider: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    provider: string,
    opts: { statusCode?: number; retryable?: boolean; cause?: Error } = {},
  ) {
    super(message, "PROVIDER_ERROR", { provider, statusCode: opts.statusCode });
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable ?? false;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * Error de parsing/validacion de output del LLM.
 * Incluye el raw text que fallo y los issues de Zod.
 */
export class SchemaError extends SladError {
  readonly rawOutput: string;
  readonly zodIssues: string[];

  constructor(
    message: string,
    rawOutput: string,
    zodIssues: string[],
    stage?: string,
  ) {
    super(message, "SCHEMA_ERROR", { stage, issueCount: zodIssues.length });
    this.name = "SchemaError";
    this.rawOutput = rawOutput;
    this.zodIssues = zodIssues;
  }
}

/**
 * Error de configuracion (API key faltante, provider invalido, etc.)
 */
export class ConfigError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "CONFIG_ERROR", context);
    this.name = "ConfigError";
  }
}

/**
 * Error de sesion (sesion no encontrada, artefacto faltante, etc.)
 */
export class SessionError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "SESSION_ERROR", context);
    this.name = "SessionError";
  }
}

/**
 * Error del harness (tarea bloqueada, hook fallo, etc.)
 */
export class HarnessError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "HARNESS_ERROR", context);
    this.name = "HarnessError";
  }
}

/**
 * Determina si un error es retryable.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  return false;
}
```

#### 3.2 `src/core/logger.ts` — Rewrite con niveles y contexto

Reemplazar el archivo actual (10 lineas) con un logger mas robusto pero sin dependencias externas:

```typescript
// src/core/logger.ts
import kleur from "kleur";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

interface LoggerOptions {
  level?: LogLevel;
  timestamps?: boolean;
}

function createLogger(opts: LoggerOptions = {}) {
  const minLevel = opts.level ?? (process.env.SLAD_LOG_LEVEL as LogLevel) ?? "info";
  const showTimestamps = opts.timestamps ?? !!process.env.SLAD_LOG_TIMESTAMPS;

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
  }

  function prefix(level: LogLevel): string {
    const ts = showTimestamps ? kleur.dim(`[${new Date().toISOString().slice(11, 23)}] `) : "";
    return ts;
  }

  return {
    debug: (msg: string, ctx?: Record<string, unknown>) => {
      if (!shouldLog("debug")) return;
      const ctxStr = ctx ? kleur.dim(` ${JSON.stringify(ctx)}`) : "";
      console.log(prefix("debug") + kleur.dim("· " + msg) + ctxStr);
    },

    info: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log(prefix("info") + kleur.cyan("›") + " " + msg);
    },

    success: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log(prefix("info") + kleur.green("✓") + " " + msg);
    },

    warn: (msg: string) => {
      if (!shouldLog("warn")) return;
      console.warn(prefix("warn") + kleur.yellow("⚠") + " " + msg);
    },

    error: (msg: string, err?: Error) => {
      if (!shouldLog("error")) return;
      console.error(prefix("error") + kleur.red("✗") + " " + msg);
      if (err?.cause) {
        console.error(prefix("error") + kleur.dim(`  cause: ${(err.cause as Error).message}`));
      }
      if (process.env.SLAD_DEBUG === "1" && err?.stack) {
        console.error(kleur.dim(err.stack));
      }
    },

    // Mantener retrocompatibilidad con el API actual
    dim: (msg: string) => {
      if (!shouldLog("debug")) return;
      console.log(kleur.gray(msg));
    },

    title: (msg: string) => {
      if (!shouldLog("info")) return;
      console.log("\n" + kleur.bold().white(msg));
    },

    // Nuevo: log estructurado para debugging
    structured: (event: string, data: Record<string, unknown>) => {
      if (!shouldLog("debug")) return;
      console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
    },
  };
}

export const log = createLogger();

// Re-export para tests o configuracion custom
export { createLogger };
export type Logger = ReturnType<typeof createLogger>;
```

**Variables de entorno nuevas:**
- `SLAD_LOG_LEVEL` — "debug" | "info" | "warn" | "error" | "silent" (default: "info")
- `SLAD_LOG_TIMESTAMPS` — "1" para mostrar timestamps
- `SLAD_DEBUG` — "1" para mostrar stack traces en errores

### Archivos a modificar

#### 3.3 Model providers — wrap errors

Cada provider debe wrappear errores del SDK en `ProviderError`. Los cambios son similares en los 4 archivos.

**`src/models/anthropic.ts`:**

```typescript
import { ProviderError } from "../core/errors.js";

// En el metodo complete(), wrap del try/catch:
try {
  // ... llamada existente al SDK ...
} catch (err: unknown) {
  const apiErr = err as { status?: number; message?: string };
  const retryable = apiErr.status === 429 || apiErr.status === 529 || apiErr.status === 500;
  throw new ProviderError(
    apiErr.message ?? "Anthropic API error",
    "anthropic",
    { statusCode: apiErr.status, retryable, cause: err as Error },
  );
}
```

**Aplicar el mismo patron a:** `openai.ts`, `gemini.ts`, `cli.ts`

Para `cli.ts`, el error retryable es `false` siempre (subprocess failure no se reintenta).

#### 3.4 `src/commands/explore.ts` — usar SchemaError

Lineas 34-43, en `parseExploreOutput()`:

```typescript
// ANTES
throw new Error(`Explorer output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);

// DESPUES
import { SchemaError } from "../core/errors.js";
throw new SchemaError(
  "Explorer output no pasa el schema",
  jsonText,
  result.error.issues.map(i => `${i.path.join(".")} — ${i.message}`),
  "explore",
);
```

**Aplicar el mismo patron a:** `run.ts` (linea 95-108, `parseRunOutput()`).

#### 3.5 `src/commands/run.ts` — retry para ProviderError

En `executeTask()`, linea 188-197 (el try/catch del provider.complete):

```typescript
// DESPUES
import { isRetryable, ProviderError } from "../core/errors.js";

// Dentro del while loop, reemplazar el try/catch del provider:
try {
  raw = await provider.complete(messages, { ... });
} catch (err) {
  if (isRetryable(err) && rounds < maxRounds) {
    spinner.text = `${task.id} · rate limited, reintentando en 5s...`;
    await new Promise(r => setTimeout(r, 5000));
    continue; // retry el mismo round
  }
  spinner.fail(`${task.id} · falló la llamada al provider`);
  throw err;
}
```

#### 3.6 `src/commands/run.ts` — error context en auto loop

En `runAutoLoop()`, linea 407 (el catch del executeTask):

```typescript
// ANTES
log.error(`Error ejecutando ${task.id}: ${(err as Error).message}`);

// DESPUES
if (err instanceof SladError) {
  log.error(`Error ejecutando ${task.id}: ${err.message}`, err);
  log.debug(`Error context`, err.context);
} else {
  log.error(`Error ejecutando ${task.id}: ${(err as Error).message}`);
}
```

#### 3.7 `src/cli.ts` — global error handler

Linea 160-163, mejorar el catch global:

```typescript
// ANTES
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

// DESPUES
import { SladError } from "./core/errors.js";

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof SladError) {
    log.error(`[${err.code}] ${err.message}`, err);
    if (Object.keys(err.context).length > 0) {
      log.debug("Context", err.context);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
```

### Tests a crear

#### 3.8 `src/core/errors.test.ts`

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, SchemaError, isRetryable } from "./errors.js";

describe("ProviderError", () => {
  it("marca rate limit como retryable", () => {
    const err = new ProviderError("rate limited", "anthropic", { statusCode: 429, retryable: true });
    assert.equal(isRetryable(err), true);
    assert.equal(err.code, "PROVIDER_ERROR");
  });

  it("marca errores generales como no retryable", () => {
    const err = new ProviderError("bad request", "openai", { statusCode: 400 });
    assert.equal(isRetryable(err), false);
  });
});

describe("SchemaError", () => {
  it("preserva raw output y issues", () => {
    const err = new SchemaError("schema fail", '{"bad": true}', ["field.missing"], "explore");
    assert.equal(err.rawOutput, '{"bad": true}');
    assert.deepEqual(err.zodIssues, ["field.missing"]);
    assert.equal(err.code, "SCHEMA_ERROR");
  });
});
```

#### 3.9 `src/core/logger.test.ts`

Test que verifica:
- `createLogger({ level: "error" })` no logea info/warn
- `createLogger({ level: "debug" })` logea todo
- API retrocompatible (`.dim()`, `.title()`, `.success()` siguen existiendo)

### Variables de entorno a documentar

Agregar a `.env.example`:

```bash
# Logging
# SLAD_LOG_LEVEL=info          # debug | info | warn | error | silent
# SLAD_LOG_TIMESTAMPS=0        # 1 para mostrar timestamps
# SLAD_DEBUG=0                  # 1 para stack traces en errores
```

### Criterios de done

- [ ] Todos los `process.exit(1)` en commands siguen funcionando (retrocompatibilidad)
- [ ] `SLAD_LOG_LEVEL=debug slad explore "test"` muestra logs de debug
- [ ] `SLAD_LOG_LEVEL=error slad explore "test"` solo muestra errores
- [ ] ProviderError con statusCode 429 se reintenta en run
- [ ] Los 4 providers wrappean errores en ProviderError
- [ ] SchemaError preserva raw output para debugging
- [ ] Tests de errors.ts pasan
- [ ] `.env.example` actualizado con nuevas variables

---

## Orden de implementacion recomendado

### Sesion 1: CLAUDE.md + AGENTS.md (15-20 min)

Es la pieza mas rapida y desbloquea que los agentes tengan contexto del proyecto. Hacerlo primero para que las sesiones siguientes de implementacion con Sonnet ya tengan el AGENTS.md disponible.

1. Crear `CLAUDE.md` (seccion 2.1)
2. Crear `AGENTS.md` (seccion 2.2)
3. Verificar que `projectContextBlock()` retorna contenido

### Sesion 2: Error handling + Logging (30-45 min)

Es foundational — el harness necesita un logger decente y errores tipados.

1. Crear `src/core/errors.ts` (seccion 3.1)
2. Rewrite `src/core/logger.ts` (seccion 3.2)
3. Actualizar `.env.example`
4. Wrap provider errors (seccion 3.3) — los 4 archivos
5. Actualizar `parseExploreOutput` y `parseRunOutput` con SchemaError (3.4)
6. Retry en executeTask (3.5)
7. Error context en autoLoop (3.6)
8. Global error handler en cli.ts (3.7)
9. Crear tests (3.8, 3.9)
10. Correr `npm test` y verificar que todo pasa

### Sesion 3: ExecutionHarness (45-60 min)

La pieza mas grande. Depende de tener el logger y los errors listos.

1. Crear `src/harness/types.ts` (seccion 1.1)
2. Crear `src/harness/classifier.ts` (seccion 1.2)
3. Crear `src/harness/audit.ts` (seccion 1.3)
4. Crear `src/harness/approval.ts` (seccion 1.4)
5. Crear `src/harness/config.ts` (seccion 1.5)
6. Crear `src/harness/index.ts` (seccion 1.6)
7. Modificar `src/commands/run.ts` (seccion 1.8)
8. Modificar `src/cli.ts` (seccion 1.9)
9. Crear tests (seccion 1.10, 1.11)
10. Test manual: `slad run T1 --harness=on`

---

## Notas para Sonnet

- El proyecto usa ESM (`"type": "module"` en package.json). Todos los imports locales llevan `.js` extension.
- Tests con `node:test`, no con jest ni vitest. Pattern: `import { describe, it } from "node:test"` + `import assert from "node:assert/strict"`.
- Script de test: `"test": "node --import tsx/esm --test src/**/*.test.ts"` (verificar en package.json).
- Los schemas Zod estan todos en `src/core/types.ts`. No crear schemas nuevos dispersos excepto en `src/harness/types.ts` (eso es deliberado — el harness es un modulo separado).
- El proyecto esta en espanol (UI, prompts, comentarios) pero el codigo (variables, funciones) esta en ingles.
- Antes de cada sesion, leer `CLAUDE.md` si ya existe para tener contexto actualizado.
