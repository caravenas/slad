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
- `plan` - `src/commands/plan.ts` - output: `PlanOutput`; use `--approve` or `--reject` for the active plan
- `run` - `src/commands/run.ts` - output: `RunOutput`
- `sessionStart` - `src/commands/session.ts`
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
slad pipeline plan --approve
```

`run`:

```bash
slad pipeline run --task T1 --harness on
slad pipeline run --parallel --bypass   # override explícito si necesitás ejecutar un plan no aprobado
```

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
