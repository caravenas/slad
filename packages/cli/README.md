# @slad/cli

CLI de SLAD OS para ejecutar un pipeline tipado de agentes:

`explore -> snapshot -> plan -> run -> learn -> evolve`

Cada etapa produce JSON validado por Zod. Los comandos no deberían importar SDKs de vendors directamente: toda integración de modelo pasa por `ModelProvider`.
El pipeline es autónomo: el auto-plan persiste un único `PlanArtifactEnvelope` pendiente y requiere aprobación explícita antes de ejecutar tareas.

## Instalación y uso rápido

```bash
npm install
npm run build
npm link
slad --help
```

Ejemplo mínimo de flujo:

```bash
slad pipeline auto "quiero agregar cache de respuestas" --dry-run
slad pipeline plan --approve
slad pipeline run --task T1
```

## Comandos disponibles

Comandos del inventario actual:

- `auto` - `src/commands/auto.ts` - output: plan pendiente de aprobación
- `chat` - `src/commands/chat.ts`
- `evolve` - `src/commands/evolve.ts` - output: `EvolveOutput`
- `explore` - `src/commands/explore.ts` - output: `ExploreOutput`
- `learn` - `src/commands/learn.ts` - output: `LearnOutput`
- `plan` - `src/commands/plan.ts` - output: `PlanOutput`; use `--approve` or `--reject` for the active plan, `--check` for a read-only preflight, `--import <path>` to import an external `slad.external-plan` JSON without invoking the model
- `run` - `src/commands/run.ts` - output: `RunOutput`
- `session` - `src/commands/session.ts` - subcomandos: `start` crea una sesión nueva y la activa; `resume` reanuda la sesión activa o la indicada; además `list`, `use`, `show`
- `snapshot` - `src/commands/snapshot.ts` - output: `SnapshotOutput`
- `stats` - `src/commands/stats.ts`

## Contrato de outputs

Outputs principales usados por el pipeline:

- `ExploreOutput`
- `SnapshotOutput`
- `PlanOutput`
- `RunOutput`
- `LearnOutput`
- `EvolveOutput`

Regla clave: antes de persistir, los outputs del agente deben validar contra su schema Zod.

## Inventario de schemas

Schemas inventariados actualmente:

- `ChatMessage`
- `CliCandidate`
- `CliDiscoveryArtifact`
- `CompletionOptions`
- `DevAgentConfig`
- `DiscoveryResult`
- `EvolveOutput`
- `ExploreOutput`
- `InventoryCommand`
- `InventoryProvider`
- `InventorySchema`
- `LearnOutput`
- `PlanOutput`
- `PlanArtifactEnvelope`
- `PlanTask`
- `ProjectConfig`
- `ProjectInventory`
- `Question`
- `RunOutput`
- `SessionAnswer`
- `SessionArtifact`
- `SessionState`
- `SnapshotOutput`

## Pipeline autónomo y aprobación de planes

Las etapas del pipeline no usan HITL ni reintentan preguntas del modelo.
Las preguntas quedan registradas como assumptions, open questions o follow-ups según el output.
`auto` persiste únicamente el plan v2 con `approval.status: "pending"`; aprobalo con `slad pipeline plan --approve` antes de `run` o de reanudar `auto`.
`plan --approve` y `run` ejecutan primero un preflight del plan: vínculo con la sesión, estado de aprobación, integridad del DAG de tareas y rutas declaradas.
`plan --check` corre ese mismo preflight en modo read-only (no exige ni registra aprobación): imprime el reporte — o el gate como JSON con `--json` — y sale con `0` si el plan está limpio, `1` si hay blockers.
Cualquier bloqueo detiene el comando con exit code distinto de cero; `--bypass` solo omite el bloqueo de aprobación faltante.
Los `files` de cada tarea deben ser rutas posix relativas, literales y normalizadas: sin globs, sin backslashes, sin rutas absolutas y sin segmentos `..`.

## Providers

El provider es `cli`, que ejecuta uno de los backends locales configurados: `claude`, `codex`, `pi` o `agy`.

Nota para contribuidores: los comandos del CLI deben depender de `ModelProvider`, no de SDKs vendor directos.

## Configuración

Mínimo recomendado:

```bash
# Timeout del provider CLI (ms)
export SLAD_CLI_TIMEOUT_MS=1800000

# Raíz de artifacts docs/log (opcional)
export SLAD_DOCS_PATH=docs
```

Configuración de proyecto:

- `DevAgentConfig` incluye `defaultProvider` y `wikiPath`.
- `ProjectConfig` incluye `docsPath` (default `docs`).
- `SLAD_DOCS_PATH` puede sobreescribir `docsPath`.

## Harness de ejecución

El arnés de seguridad está habilitado y soporta modos:

- `off`
- `on`
- `strict`

Uso en `run`/`auto`:

```bash
slad pipeline run --task T1 --harness off
slad pipeline run --task T1 --harness on
slad pipeline run --task T1 --harness strict
```

El harness también puede tomar configuración desde `.slad-os/harness.json`.

## Ejemplos ejecutables

`explore`:

```bash
slad pipeline explore "quiero añadir comando de limpieza de cache" --provider cli
```

`snapshot`:

```bash
slad pipeline snapshot --intent "definir estrategia de cache" --provider cli
```

`plan`:

```bash
slad pipeline plan --input ./docs/log/snapshots/<sessionId>.json --provider cli
slad pipeline plan --import ./external-plan.json   # plan externo canónico, sin LLM
slad pipeline plan --approve
```

`--import` lee un documento JSON estricto `{ kind: "slad.external-plan", schemaVersion: 1, intent, snapshot, plan, source? }`.
Requiere sesión activa con la misma intención (comparación con trim) y no puede combinarse con `--check`, `--approve`, `--reject` ni `--skip-session`.
SLAD reconstruye el envelope al importar (planId/revision/digest/approval/planHash propios); el documento pasa el mismo preflight y, si falla, no se persiste nada.
El plan importado queda `pending` y puede superseder al plan previo de la sesión.

`run`:

```bash
slad pipeline run --task T1 --harness on
slad pipeline run --parallel --bypass   # override explícito si necesitás ejecutar un plan no aprobado
```

`--worktrees` requiere `--parallel`, un HEAD commiteado y un worktree principal limpio; cambios sin commitear abortan el run antes de lanzar workers.
El run termina `review_pending`: el resultado integrado queda en la rama de integración de la sesión (`slad/<sessionId>/...`) y el worktree principal no se toca.
Usá `slad pipeline run --review <runId>` para inspeccionar, `--apply <runId>` para dejar un único squash staged, `--abort <runId>` para limpiar la integración, o `--from-review <runId>` para continuar desde ese tip.

Tests (`node:test`):

```bash
node --import tsx/esm --test 'src/**/*.test.ts'
```

## Estructura clave

- `src/commands/`: implementación de comandos
- `src/models/`: providers y wrappers (`ModelProvider`)
- `src/core/types.ts`: contratos compartidos y re-export de tipos/schemas
- `src/harness/`: clasificación y control de riesgo en ejecución
- `src/persistence/`: persistencia de artifacts `docs/log/*`

## Notas para contribuidores

- Mantener compatibilidad de imports internos vía `src/core/types.ts`.
- No agregar pausas HITL a los stages del pipeline; registrar incertidumbre en el campo de output correspondiente.
- Evitar cambios fuera de scope al actualizar documentación: reflejar sólo lo que existe en código.
