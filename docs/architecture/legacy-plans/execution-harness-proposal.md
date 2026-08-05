# ExecutionHarness — Propuesta Arquitectónica

> Capa de seguridad y gobernanza configurable para la fase Run de SLAD OS.
> **Principio de diseño:** opt-in middleware, no core rewrite.

---

## 1. Decisión arquitectónica

El arnés se integra como un **middleware entre el Planner y el Builder**, no como el core del sistema. SLAD OS sigue siendo un orquestador de desarrollo; el arnés le agrega un perímetro de seguridad cuando el contexto lo requiere.

**Trade-off clave:** `--harness=off` para prototipos rápidos, `--harness=on` (o `--harness=strict`) para entornos enterprise con compliance.

---

## 2. Interfaces TypeScript

### 2.1 Niveles de permiso

```typescript
// src/harness/types.ts

import { z } from "zod";
import type { PlanTask, RunOutput, ChatMessage } from "../core/types.js";
import type { ModelProvider } from "../models/index.js";

export const PermissionLevel = z.enum(["read", "workspace", "full"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const CommandClassification = z.object({
  original: z.string(),
  level: PermissionLevel,
  reason: z.string(),
  patterns: z.array(z.string()).default([]),
});
export type CommandClassification = z.infer<typeof CommandClassification>;
```

### 2.2 Hooks

```typescript
export type HookVerdict =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; patch: Partial<PlanTask> };

export interface PreTaskHook {
  name: string;
  /** Ejecuta antes de enviar la tarea al Builder. Puede bloquear o modificar. */
  execute(ctx: PreTaskContext): Promise<HookVerdict>;
}

export interface PostTaskHook {
  name: string;
  /** Ejecuta después de recibir el RunOutput. No puede bloquear, solo auditar. */
  execute(ctx: PostTaskContext): Promise<void>;
}

export interface PreTaskContext {
  task: PlanTask;
  sessionId: string | null;
  permissionLevel: PermissionLevel;
  /** Permisos asignados a esta sesión */
  sessionPermissions: PermissionLevel;
}

export interface PostTaskContext {
  task: PlanTask;
  output: RunOutput;
  /** Clasificaciones de comandos detectados en el output */
  classifications: CommandClassification[];
  durationMs: number;
  changedFiles: string[];
}
```

### 2.3 Configuración del arnés

```typescript
export const HarnessMode = z.enum(["off", "on", "strict"]);
export type HarnessMode = z.infer<typeof HarnessMode>;

export const HarnessConfig = z.object({
  mode: HarnessMode.default("off"),

  /** Nivel máximo de permiso para la sesión */
  maxPermission: PermissionLevel.default("workspace"),

  /** Comandos/patrones que siempre requieren aprobación humana */
  alwaysApprove: z.array(z.string()).default([
    "rm -rf", "sudo", "shutdown", "DROP TABLE",
    "git push --force", "npm publish",
  ]),

  /** Directorios permitidos para escritura (workspace mode) */
  allowedWritePaths: z.array(z.string()).default(["./src", "./tests", "./docs"]),

  /** Habilitar log de auditoría LDJSON */
  auditLog: z.boolean().default(true),

  /** Ruta del archivo de auditoría */
  auditLogPath: z.string().default(".slad-os/audit.ldjson"),

  /** Hooks personalizados (paths a módulos ESM) */
  preTaskHooks: z.array(z.string()).default([]),
  postTaskHooks: z.array(z.string()).default([]),
});
export type HarnessConfig = z.infer<typeof HarnessConfig>;
```

### 2.4 Interfaz principal del arnés

```typescript
// src/harness/index.ts

export interface ExecutionHarness {
  readonly config: HarnessConfig;

  /** Evalúa si una tarea puede ejecutarse. Corre pre-task hooks. */
  beforeTask(task: PlanTask, sessionId: string | null): Promise<HookVerdict>;

  /** Clasifica comandos en el output del Builder. */
  classifyOutput(output: RunOutput): CommandClassification[];

  /** Verifica si el output requiere aprobación interactiva. */
  requiresApproval(classifications: CommandClassification[]): boolean;

  /** Registra el resultado en el audit log. Corre post-task hooks. */
  afterTask(task: PlanTask, output: RunOutput, durationMs: number): Promise<void>;

  /** Flush del audit log (llamar en shutdown). */
  flush(): Promise<void>;
}
```

---

## 3. Clasificador dinámico de comandos

El clasificador analiza el `RunOutput` (específicamente `changedFiles` y `verification.command`) para determinar el nivel de riesgo real de lo que el Builder ejecutó o propone ejecutar.

```typescript
// src/harness/classifier.ts

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; level: PermissionLevel; reason: string }> = [
  // Full (alto riesgo)
  { pattern: /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f)+/,   level: "full", reason: "Borrado recursivo/forzado" },
  { pattern: /\bsudo\b/,                               level: "full", reason: "Elevación de privilegios" },
  { pattern: /\bchmod\s+[0-7]{3,4}/,                   level: "full", reason: "Cambio de permisos" },
  { pattern: /\bgit\s+push\s+.*--force/,               level: "full", reason: "Push forzado" },
  { pattern: /\bnpm\s+publish\b/,                       level: "full", reason: "Publicación a registry" },
  { pattern: /\bDROP\s+(TABLE|DATABASE)/i,              level: "full", reason: "Operación destructiva en DB" },
  { pattern: /\bshutdown\b|\breboot\b/,                 level: "full", reason: "Apagado del sistema" },

  // Workspace (escritura controlada)
  { pattern: /\btouch\b|\bmkdir\b/,                     level: "workspace", reason: "Creación de archivos/dirs" },
  { pattern: /\bsed\s+-i\b|\bawk\b.*>/,                 level: "workspace", reason: "Edición in-place" },
  { pattern: /\bnpm\s+install\b/,                        level: "workspace", reason: "Instalación de dependencias" },
  { pattern: /\bgit\s+(commit|add|checkout|branch)\b/,  level: "workspace", reason: "Operación git local" },

  // Read (seguro) — no necesita patrones, es el default
];

export function classifyCommand(command: string): CommandClassification {
  for (const { pattern, level, reason } of DANGEROUS_PATTERNS) {
    const match = command.match(pattern);
    if (match) {
      return {
        original: command,
        level,
        reason,
        patterns: [match[0]],
      };
    }
  }
  return { original: command, level: "read", reason: "Sin patrones peligrosos detectados", patterns: [] };
}

export function classifyRunOutput(output: RunOutput): CommandClassification[] {
  const commands = output.verification.map((v) => v.command);
  return commands.map(classifyCommand);
}

export function highestLevel(classifications: CommandClassification[]): PermissionLevel {
  const order: PermissionLevel[] = ["read", "workspace", "full"];
  let max: PermissionLevel = "read";
  for (const c of classifications) {
    if (order.indexOf(c.level) > order.indexOf(max)) {
      max = c.level;
    }
  }
  return max;
}
```

---

## 4. Sistema de auditoría LDJSON

```typescript
// src/harness/audit.ts

import fs from "node:fs";

export type AuditEventKind =
  | "task_start"
  | "task_end"
  | "hook_verdict"
  | "command_classified"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "policy_violation";

export interface AuditEvent {
  timestamp: string;       // ISO 8601
  sessionId: string | null;
  taskId: string;
  kind: AuditEventKind;
  data: Record<string, unknown>;
}

export class AuditLogger {
  private fd: number | null = null;

  constructor(private logPath: string) {}

  private ensureOpen(): void {
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.fd = fs.openSync(this.logPath, "a");  // append-only
    }
  }

  log(event: AuditEvent): void {
    this.ensureOpen();
    const line = JSON.stringify(event) + "\n";
    fs.writeSync(this.fd!, line);
    fs.fsyncSync(this.fd!);  // flush inmediato — integridad ante crash
  }

  async flush(): Promise<void> {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
```

**Relación con SessionState:** El audit log no reemplaza `SessionState`. Son complementarios:

| Aspecto | SessionState | AuditLog |
|---------|-------------|----------|
| Propósito | Tracking de artefactos y flujo | Trazabilidad forense |
| Granularidad | Por stage/tarea | Por evento atómico |
| Formato | JSON estructurado | LDJSON append-only |
| Mutabilidad | Se actualiza | Solo append |
| Uso | Resume, context injection | Post-mortem, compliance |

---

## 5. Integración con `run.ts` — punto de inserción exacto

La integración se hace con cambios mínimos en `executeTask()` y `runAutoLoop()`. El arnés envuelve la ejecución sin alterar el flujo HITL existente.

### 5.1 Cambios en `executeTask()`

```typescript
// ANTES (líneas 163-244 actuales):
async function executeTask(
  task: PlanTask,
  plan: ...,
  provider: ModelProvider,
  ...
): Promise<TaskResult> {
  // → directo al provider.complete()
}

// DESPUÉS:
async function executeTask(
  task: PlanTask,
  plan: ...,
  provider: ModelProvider,
  model: string,
  maxRounds: number,
  sessionCtx: string,
  outputDir: string,
  harness: ExecutionHarness | null,  // ← nuevo parámetro, null = sin arnés
): Promise<TaskResult> {

  // ── PRE-TASK: verificar si la tarea puede ejecutarse ──
  if (harness) {
    const verdict = await harness.beforeTask(task, sessionId);
    if (verdict.action === "deny") {
      // Retornar RunOutput con status "blocked" sin llamar al provider
      return {
        output: {
          taskId: task.id,
          status: "blocked",
          summary: `Harness denied: ${verdict.reason}`,
          changedFiles: [], verification: [], reviewerNotes: [],
          followUps: [], questions: [], humanAnswers: {},
        },
        outPath: "...",
        humanAnswers: {},
      };
    }
    if (verdict.action === "modify") {
      task = { ...task, ...verdict.patch };  // aplicar modificaciones del hook
    }
  }

  // ── EJECUCIÓN: loop HITL existente (sin cambios) ──
  const messages: ChatMessage[] = [
    { role: "user", content: buildUserContent(plan, task, sessionCtx) },
  ];
  // ... todo el while loop actual se mantiene idéntico ...

  // ── POST-PROVIDER: clasificar output ──
  if (harness && output) {
    const classifications = harness.classifyOutput(output);

    // Si requiere aprobación y no la tiene, pausar
    if (harness.requiresApproval(classifications)) {
      // Reutilizar el mecanismo HITL existente
      const approved = await confirmDangerousAction(task.id, classifications);
      if (!approved) {
        output = { ...output, status: "blocked",
          reviewerNotes: [...output.reviewerNotes, "Harness: acción peligrosa rechazada por el usuario"],
        };
      }
    }
  }

  // ── POST-TASK: auditoría ──
  if (harness) {
    await harness.afterTask(task, output, Date.now() - taskStart);
  }

  // ... persistencia existente sin cambios ...
  return { output, outPath, humanAnswers: allHumanAnswers };
}
```

### 5.2 Cambios en `RunOpts`

```typescript
export interface RunOpts {
  // ... existentes ...
  harness?: "off" | "on" | "strict";  // ← nuevo, default: "off"
}
```

### 5.3 Cambios en `runCommand()`

```typescript
export async function runCommand(opts: RunOpts): Promise<void> {
  // ... setup existente ...

  // ── Inicializar harness si está habilitado ──
  const harness = opts.harness && opts.harness !== "off"
    ? await createHarness(loadHarnessConfig(opts.harness))
    : null;

  try {
    if (opts.auto) {
      await runAutoLoop(plan, provider, model, opts, session, harness);
    } else {
      // single-task con harness
      result = await executeTask(task, plan, provider, model, maxRounds, sessionCtx, outputDir, harness);
    }
  } finally {
    // Siempre flush el audit log
    await harness?.flush();
  }
}
```

---

## 6. Aprobación interactiva — extensión del HITL

En lugar de crear un mecanismo nuevo, el arnés extiende el HITL existente con una función dedicada para acciones peligrosas:

```typescript
// src/harness/approval.ts

import { confirm } from "@inquirer/prompts";
import kleur from "kleur";
import type { CommandClassification } from "./types.js";

export async function confirmDangerousAction(
  taskId: string,
  classifications: CommandClassification[],
): Promise<boolean> {
  const dangerous = classifications.filter((c) => c.level === "full");
  if (dangerous.length === 0) return true;

  console.log("");
  console.log(kleur.bold().red(`⚠ ${taskId} · Acción de alto riesgo detectada`));
  for (const c of dangerous) {
    console.log(kleur.red(`  ● ${c.reason}: `) + kleur.dim(c.original));
  }
  console.log("");

  return confirm({
    message: `¿Autorizás la ejecución de ${dangerous.length} acción(es) de nivel Full?`,
    default: false,
  });
}
```

---

## 7. Configuración por proyecto

El arnés se configura en el archivo `.slad-os/harness.json` del proyecto:

```json
{
  "mode": "on",
  "maxPermission": "workspace",
  "alwaysApprove": [
    "rm -rf",
    "git push --force",
    "npm publish"
  ],
  "allowedWritePaths": [
    "./src",
    "./tests",
    "./docs",
    "./scripts"
  ],
  "auditLog": true,
  "preTaskHooks": [
    "./hooks/no-secrets-in-code.mjs"
  ],
  "postTaskHooks": [
    "./hooks/notify-slack.mjs"
  ]
}
```

---

## 8. Ejemplo de hook personalizado

```typescript
// hooks/no-secrets-in-code.mjs
// Pre-task hook que previene la escritura de secrets en código

/** @type {import('../src/harness/types.js').PreTaskHook} */
export default {
  name: "no-secrets-in-code",
  async execute(ctx) {
    // Verificar si la tarea menciona archivos .env o credentials
    const sensitiveFiles = ctx.task.files.filter(
      (f) => f.includes(".env") || f.includes("credentials") || f.includes("secrets")
    );
    if (sensitiveFiles.length > 0 && ctx.permissionLevel !== "full") {
      return {
        action: "deny",
        reason: `Archivos sensibles detectados: ${sensitiveFiles.join(", ")}. Requiere permiso Full.`,
      };
    }
    return { action: "allow" };
  },
};
```

---

## 9. Qué NO cambia

Para ser explícito sobre los boundaries:

- **ModelProvider** sigue siendo la abstracción de comunicación con LLMs. El arnés no la envuelve ni la reemplaza.
- **SessionState** sigue manejando artefactos y context injection. El audit log es complementario.
- **El loop HITL** no se modifica. El arnés usa `confirm()` de inquirer para aprobaciones, pero no interfiere con `collectAnswers()`.
- **Zod schemas** no cambian. `RunOutput` sigue validando lo mismo.
- **Los otros 5 stages** (explore, snapshot, plan, learn, evolve) no se ven afectados. El arnés solo envuelve Run.

---

## 10. Roadmap de implementación

### Fase 1 — Fundamentos (2-3 días)
- `src/harness/types.ts` — interfaces y schemas
- `src/harness/classifier.ts` — clasificador de comandos
- `src/harness/audit.ts` — logger LDJSON
- `src/harness/index.ts` — implementación de `ExecutionHarness`
- Integración básica en `run.ts` (parámetro `--harness`)

### Fase 2 — Hooks y aprobación (1-2 días)
- `src/harness/approval.ts` — confirmación interactiva
- Carga dinámica de hooks ESM
- Hook de ejemplo: `no-secrets-in-code`
- Tests para el clasificador

### Fase 3 — Configuración y CLI (1 día)
- `.slad-os/harness.json` loader
- Flag `--harness=off|on|strict` en commander
- Documentación en AGENTS.md
