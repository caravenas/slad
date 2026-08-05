# SLAD OS v0.3 — Harness Engineering Plan

> Plan de implementacion para incorporar las ideas del paradigma de _Harness
> Engineering_ (OpenAI Symphony) a SLAD OS. Cada pieza es autocontenida:
> tiene contexto, archivos a crear/modificar, interfaces, y criterios de done.
>
> **Origen:** evaluacion del documento "Protocolo de Estandares Tecnicos para
> la Ingenieria de Arneses en la Resolucion Autonoma de Tickets". Las ideas
> seleccionadas son las que tienen alto encaje con la arquitectura actual
> (`ExecutionHarness`, `SessionState`, `ModelProvider`) sin requerir
> reescrituras.

---

## Vision general

El paradigma de Harness Engineering parte de una premisa: el cuello de
botella ya no es la capacidad del LLM, sino la _bootability_ del entorno y
la confiabilidad de la verificacion. Tres piezas convergen para resolver
esto en SLAD OS:

```
ticket / intencion
        │
        ▼
   ┌───────────────┐
   │  Bootability  │  ← detecta setup, valida que el repo es ejecutable
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │   Worktree    │  ← aisla la sesion en un directorio dedicado
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ Builder/Run   │  ← (sin cambios estructurales)
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ Visual Verify │  ← Playwright CRI graba evidencia
   └───────────────┘
```

Tier 1 son los cimientos. Tier 2 (ticket-driven, workflow.mmd export,
observability) se construye encima cuando Tier 1 este estable.

---

## Pieza 1: Git Worktrees como modo de aislamiento

### Contexto

Hoy el Builder ejecuta tareas en el cwd del proyecto. Eso impide ejecutar
multiples sesiones en paralelo y mezcla estado entre tareas (branches, node
modules, archivos sin commitear). Git worktrees resuelven esto: un worktree
es un checkout adicional del mismo repo en otro directorio, con su propia
working tree y branch, compartiendo el `.git` central.

El objetivo es que `run` (especialmente `--auto`) pueda opcionalmente correr
cada sesion en un worktree dedicado, y que al terminar el output (commits,
diff, archivos modificados) se exponga al humano para decidir merge o
discard.

### Archivos a crear

#### 1.1 `src/worktree/types.ts`

```typescript
import { z } from "zod";

export const WorktreeConfigSchema = z.object({
  baseDir: z.string().default(".slad-os/worktrees"),
  branchPrefix: z.string().default("slad/"),
  autoCleanup: z.boolean().default(false),
});
export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema>;

export interface WorktreeHandle {
  id: string;              // session-derived, ej. "T1-abc123"
  path: string;            // absolute path al worktree
  branch: string;          // ej. "slad/T1-abc123"
  baseBranch: string;      // ej. "main" — desde donde se creo
  createdAt: string;
}

export interface WorktreeManager {
  create(opts: { sessionId: string; baseBranch?: string }): Promise<WorktreeHandle>;
  list(): Promise<WorktreeHandle[]>;
  remove(id: string, opts?: { force?: boolean }): Promise<void>;
  status(id: string): Promise<{ ahead: number; behind: number; dirty: boolean }>;
}
```

#### 1.2 `src/worktree/manager.ts`

Implementacion `GitWorktreeManager implements WorktreeManager` usando
`child_process.execFileSync` con `git worktree add/list/remove/prune`.

Reglas:
- El `baseDir` se resuelve desde el git root, no desde el cwd.
- El branch name combina `branchPrefix + sessionId + sufijo corto` para
  evitar colisiones.
- `remove(force=false)` falla si el worktree esta dirty; con `force=true`
  ejecuta `git worktree remove --force`.
- Persistir la lista de handles en `.slad-os/worktrees/registry.json` para
  que `list()` sobreviva crashes (no confiar solo en `git worktree list`).

#### 1.3 `src/worktree/index.ts`

Re-exporta tipos y la factory:

```typescript
export function createWorktreeManager(config?: Partial<WorktreeConfig>): WorktreeManager;
```

### Archivos a modificar

#### 1.4 `src/commands/run.ts`

Agregar flags:
- `--isolated` — crea un worktree para la sesion completa (toda la corrida `--auto`)
- `--worktree <path>` — usa un worktree ya existente (caso resume)
- `--keep-worktree` — no elimina al terminar (default: pregunta al humano)

Flujo:

```typescript
let workdir = process.cwd();
let worktree: WorktreeHandle | undefined;

if (opts.isolated) {
  const mgr = createWorktreeManager();
  worktree = await mgr.create({ sessionId: session.id });
  workdir = worktree.path;
  log.info(`Worktree creado en ${worktree.path} (branch ${worktree.branch})`);
}

try {
  await executeTaskOrAutoLoop({ ...opts, cwd: workdir });
} finally {
  if (worktree && !opts.keepWorktree) {
    const decision = await askWorktreeDecision(worktree); // merge / keep / discard
    if (decision === "discard") await mgr.remove(worktree.id, { force: true });
  }
}
```

#### 1.5 `src/core/session.ts`

Agregar `worktreePath?: string` al `SessionState` para que `resume`
detection sepa donde estaba corriendo la sesion previa.

### Criterios de done

- `slad run --isolated --auto` crea worktree, corre todas las tareas dentro,
  y al terminar pregunta merge/keep/discard.
- `slad session show` muestra `worktreePath` cuando aplica.
- `git worktree list` lista los worktrees creados con prefijo `slad/`.
- Test: `npm test src/worktree/manager.test.ts` cubre create, list, remove,
  remove-force-when-dirty.
- Documentacion en README seccion "Aislamiento por sesion".

### Riesgos / decisiones abiertas

- ¿Que hacer si el repo no esta inicializado en git? Fallback a cwd con warning.
- ¿Que pasa con `node_modules`? Por defecto cada worktree tiene los suyos
  (lento la primera vez). Opcion futura: hard-link o symlink.
- Interaccion con el `ExecutionHarness`: el harness ya audita comandos; en
  modo isolated, el cwd que recibe el classifier debe ser el del worktree.

---

## Pieza 2: Bootability stage

### Contexto

Para que un agente sea autonomo end-to-end, el repo tiene que ser "bootable"
de forma determinista: cualquier humano (o agente) que lo clone debe poder
levantarlo con un solo comando documentado. Hoy SLAD asume que el entorno ya
esta listo. Esta pieza agrega un `BootabilityReport` que el Planner consume
para decidir si la tarea es viable o requiere setup previo.

No es un comando nuevo del usuario. Es un sub-stage interno que corre antes
del primer `run` de una sesion (y opcionalmente como parte de `explore`).

### Archivos a crear

#### 2.1 `src/bootability/types.ts`

```typescript
import { z } from "zod";

export const BootabilityCheckSchema = z.object({
  kind: z.enum(["package_manager", "env_var", "service", "binary", "migration"]),
  name: z.string(),
  required: z.boolean(),
  detected: z.boolean(),
  command: z.string().optional(),     // como satisfacerlo
  notes: z.string().default(""),
});

export const BootabilityReportSchema = z.object({
  bootable: z.boolean(),               // true si todos los required pasan
  checks: z.array(BootabilityCheckSchema),
  setupCommands: z.array(z.string()),  // ordenados, idempotentes
  estimatedSetupTimeSec: z.number().optional(),
  warnings: z.array(z.string()),
});

export type BootabilityReport = z.infer<typeof BootabilityReportSchema>;
```

#### 2.2 `src/bootability/detectors.ts`

Detectores deterministicos (sin LLM) que retornan `BootabilityCheck[]`:

- `detectPackageManager(root)` — busca `package.json`, `pnpm-lock.yaml`,
  `bun.lockb`, `requirements.txt`, `Pipfile`, `go.mod`, `Cargo.toml`.
- `detectEnvVars(root)` — lee `.env.example` y compara con `process.env`.
- `detectServices(root)` — busca `docker-compose.yml`, `Dockerfile`, archivos
  de config tipicos (postgres, redis, etc.).
- `detectBinaries(checks)` — para cada binario referido en scripts de setup,
  verifica con `which`.

Cada detector retorna shape uniforme; el orquestador los agrega.

#### 2.3 `src/bootability/runner.ts`

```typescript
export async function runBootabilityCheck(
  root: string,
  opts?: { strict?: boolean },
): Promise<BootabilityReport>;

export async function executeSetup(
  report: BootabilityReport,
  opts?: { dryRun?: boolean; cwd?: string },
): Promise<{ ok: boolean; failed?: string }>;
```

`executeSetup` corre `report.setupCommands` en orden. En `dryRun` solo
imprime. Cualquier non-zero exit interrumpe.

#### 2.4 `src/bootability/index.ts`

Re-exporta API publica.

### Archivos a modificar

#### 2.5 `src/commands/run.ts`

Antes del primer `executeTask` de la sesion, correr `runBootabilityCheck`.
Si `bootable === false`, ofrecer:

1. Ejecutar `setupCommands` automaticamente
2. Mostrar el reporte y abortar (humano hace el setup)
3. Continuar igual (ignora warnings)

Almacenar el reporte como artefacto: `appendArtifact({ kind: "bootability", path })`.

#### 2.6 `src/agents/prompts.ts`

El Planner debe recibir un resumen del `BootabilityReport` en el prompt:
"el entorno ya tiene X instalado, falta Y". Esto le permite generar tareas
realistas (no asumir que postgres esta corriendo si no lo esta).

### Criterios de done

- `slad run` en un repo sin `node_modules` detecta `package.json`, ofrece
  `npm install`, y solo continua si el humano acepta o el flag `--auto-setup`
  esta activo.
- El reporte queda en `runs/<timestamp>-bootability.json`.
- El Planner recibe el reporte como contexto inyectado.
- Test: `npm test src/bootability/detectors.test.ts` cubre los 4 detectores
  contra fixtures.

### Riesgos / decisiones abiertas

- Velocidad: correr todos los detectores en cada `run` puede ser caro.
  Cachear el reporte por `git rev-parse HEAD + content hash de package.json`.
- ¿Quien define que es "required"? V1: heurisica. V2: archivo
  `.slad-os/bootability.json` editable por el usuario.

---

## Pieza 3: Playwright CRI verifier

### Contexto

`RunOutput.verification[].command` hoy es solo texto que ejecuta el harness.
Para tareas que tocan UI (un componente nuevo, un fix de regresion visual,
un fix de e2e), el verificador deberia producir _evidencia visual_:
screenshots y video que el revisor humano pueda inspeccionar sin clonar el
repo.

El protocolo recomienda Playwright CRI directo (no MCP) por eficiencia de
tokens y control nativo de grabacion. Esta pieza agrega un nuevo tipo de
verificacion (`kind: "e2e_video"`) y el runner correspondiente.

### Archivos a crear

#### 3.1 `src/verifiers/types.ts`

Extender el schema de verificacion existente:

```typescript
import { z } from "zod";

export const E2EVerificationSchema = z.object({
  kind: z.literal("e2e_video"),
  url: z.string().url(),
  scenario: z.string(),                // descripcion humana
  script: z.string(),                  // codigo Playwright a ejecutar
  expectedAssertions: z.array(z.string()).default([]),
  recordVideo: z.boolean().default(true),
  recordScreenshots: z.boolean().default(true),
});

export const VerificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string(), /* ...existente */ }),
  E2EVerificationSchema,
]);
```

**Nota:** esto requiere migrar el schema existente en `core/types.ts` a
discriminated union. El Planner tambien debe actualizarse para emitir el
campo `kind`.

#### 3.2 `src/verifiers/playwright-cri.ts`

```typescript
export interface E2EResult {
  ok: boolean;
  videoPath?: string;
  screenshotPaths: string[];
  consoleErrors: string[];
  assertionResults: Array<{ name: string; passed: boolean; message?: string }>;
  durationMs: number;
}

export async function runE2EVerification(
  spec: E2EVerification,
  opts: { outputDir: string; cwd: string },
): Promise<E2EResult>;
```

Implementacion:
- Lanza Chromium via Playwright con `recordVideo: { dir }`.
- Ejecuta `spec.script` en un sandbox (Function constructor con `page`,
  `expect` inyectados — controlado, no eval libre).
- Captura screenshots en cada assertion.
- Devuelve paths absolutos a `outputDir`.

#### 3.3 `src/verifiers/index.ts`

Dispatcher:

```typescript
export async function runVerification(
  v: Verification,
  ctx: VerificationContext,
): Promise<VerificationResult>;
```

Switch sobre `v.kind`. Para `command` delega al harness existente; para
`e2e_video` llama a `runE2EVerification`.

### Archivos a modificar

#### 3.4 `src/commands/run.ts`

Despues de cada tarea, en lugar de ejecutar `verification.command`
directamente, llamar al dispatcher. Los artefactos visuales se registran en
la sesion:

```typescript
session.appendArtifact({
  kind: "verification_evidence",
  path: result.videoPath,
  meta: { taskId, scenario: spec.scenario },
});
```

#### 3.5 `src/agents/prompts.ts` (Reviewer)

El Reviewer ahora puede recibir paths a videos/screenshots como evidencia.
El prompt debe instruirlo: "si hay `verification_evidence` con tipo
`e2e_video`, asume que ya fue grabado y referencialo en el resumen final".

### Criterios de done

- Una tarea con `verification.kind === "e2e_video"` produce un MP4 en
  `runs/<timestamp>-<task>/video.webm`.
- Los assertion results se reflejan en `RunOutput`.
- Errores de consola del browser se incluyen en el reporte.
- README documenta como definir un verifier e2e en el plan.
- Test: smoke test contra `https://example.com` con assertion trivial.

### Riesgos / decisiones abiertas

- Playwright es una dependencia pesada (~300MB con browsers). Hacerla
  `optionalDependency` y degradar gracefully si falta.
- Seguridad del `script` ejecutable: por ahora restringir a sandbox con
  globals controlados; v2 podria parsear AST para validar.
- Costo de almacenamiento: rotacion automatica de videos viejos via cache
  GC futuro.

---

## Tier 2 — esbozos

Las siguientes piezas se implementaran cuando Tier 1 este estable y haya
uso real validando la direccion. Aqui solo dejo el esqueleto.

### Pieza 4: Ticket-driven mode

- **Concepto:** trigger del pipeline desde transiciones de estado en un
  rastreador externo (Linear primero).
- **Archivo nuevo:** `src/triggers/ticket-trigger.ts` con interface
  `TicketTrigger { onStateChange(handler) }`.
- **Adapter:** `src/triggers/linear.ts` usando webhooks o polling.
- **Comando:** `slad daemon --watch linear` que mantiene un proceso vivo
  escuchando transiciones (`To-do → In Progress` dispara `explore + plan`,
  `In Progress → Merging` dispara crear PR).
- **Dependencia:** persistencia de state machine externa (mapeo
  `ticketId ↔ sessionId`).

### Pieza 5: `workflow.mmd` export

- **Concepto:** generar un diagrama Mermaid del pipeline configurado por
  proyecto, con frontmatter YAML que documente parametros (modelos,
  modos del harness, providers).
- **Comando:** `slad export-workflow --output workflow.mmd`.
- **Render:** GitHub renderiza Mermaid nativamente, asi que el archivo
  sirve como documentacion ejecutable.
- **No es config de entrada** — es solo export. La config sigue viviendo en
  `.env`, `.slad-os/harness.json`, `AGENTS.md`.

### Pieza 6: Observability ContextProvider

- **Concepto:** abstraccion `ContextProvider` que permite al Explorer
  consumir datos externos (logs Grafana, errores Sentry, metricas Datadog)
  como evidencia, no solo el codebase.
- **Interface:** `ContextProvider { fetch(query): Promise<Evidence[]> }`.
- **Adapters iniciales:** `GrafanaProvider`, `SentryProvider`.
- **Cuando:** despues de Bootability, porque comparte el patron de
  inyeccion de evidencia al prompt.

---

## Orden recomendado

1. **Worktrees** (Pieza 1) — cimiento de todo lo demas, no rompe flujo actual.
2. **Bootability** (Pieza 2) — desbloquea autonomia real, complementa el harness.
3. **Playwright CRI** (Pieza 3) — cierra el loop de verificacion visual.
4. (Estabilizar, recoger feedback de uso real durante 1-2 sprints)
5. Tier 2 segun necesidad observada.

Cada pieza Tier 1 es un PR independiente. Ninguna depende de las otras
para mergear, pero las tres juntas forman el "harness" coherente del
paradigma.
