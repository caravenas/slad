# @slad/cli

CLI de SLAD OS para ejecutar un pipeline tipado de agentes:

`explore -> snapshot -> plan -> run -> learn -> evolve`

Cada etapa produce JSON validado por Zod. Los comandos no deberían importar SDKs de vendors directamente: toda integración de modelo pasa por `ModelProvider`.

## Instalación y uso rápido

```bash
npm install
npm run build
npm link
slad --help
```

Ejemplo mínimo de flujo:

```bash
slad explore "quiero agregar cache de respuestas"
slad snapshot
slad plan
slad run --task T1
```

## Comandos disponibles

Comandos del inventario actual:

- `auto` (HITL) - `src/commands/auto.ts` - output: `ExploreOutput`
- `chat` - `src/commands/chat.ts`
- `evolve` (HITL) - `src/commands/evolve.ts` - output: `EvolveOutput`
- `explore` (HITL) - `src/commands/explore.ts` - output: `ExploreOutput`
- `learn` (HITL) - `src/commands/learn.ts` - output: `LearnOutput`
- `plan` (HITL) - `src/commands/plan.ts` - output: `PlanOutput`
- `run` (HITL) - `src/commands/run.ts` - output: `RunOutput`
- `sessionStart` (HITL) - `src/commands/session.ts`
- `snapshot` (HITL) - `src/commands/snapshot.ts` - output: `SnapshotOutput`
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
- `PlanTask`
- `ProjectConfig`
- `ProjectInventory`
- `Question`
- `RunOutput`
- `SessionAnswer`
- `SessionArtifact`
- `SessionState`
- `SnapshotOutput`

## HITL (Human-in-the-loop)

Contrato obligatorio para pausa humana:

- `status: "awaiting_human"`
- `questions[]` con preguntas estructuradas

Esto aplica a comandos HITL y a respuestas intermedias del loop.

## Providers

Providers inventariados:

- `anthropic` (`src/models/anthropic.ts`) - SDK `@anthropic-ai/sdk`
- `cli-discovery` (`src/models/cli-discovery.ts`)
- `gemini` (`src/models/gemini.ts`) - SDK `@google/generative-ai`
- `openai` (`src/models/openai.ts`) - SDK `openai`
- `retry` (`src/models/retry.ts`)
- `timeout` (`src/models/timeout.ts`)
- `tool-loop` (`src/models/tool-loop.ts`)
- `cli` (`src/models/cli.ts`) - binarios: `codex`, `gemini`, `claude`, `agent`

Nota para contribuidores: los comandos del CLI deben depender de `ModelProvider`, no de SDKs vendor directos.

## Configuración

Mínimo recomendado:

```bash
# Provider por defecto
export SLAD_DEFAULT_PROVIDER=anthropic

# Contexto opcional de wiki para explorer/evolve
export SLAD_WIKI_PATH=/ruta/a/wiki

# API keys por provider
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export GEMINI_API_KEY=...

# Modelo default global u overrides por provider
export SLAD_MODEL=...
export ANTHROPIC_MODEL=...
export OPENAI_MODEL=...
export GEMINI_MODEL=...

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
slad run --task T1 --harness off
slad run --task T1 --harness on
slad run --task T1 --harness strict
```

El harness también puede tomar configuración desde `.slad-os/harness.json`.

## Ejemplos ejecutables

`explore`:

```bash
slad explore "quiero añadir comando de limpieza de cache" --provider openai
```

`snapshot`:

```bash
slad snapshot --intent "definir estrategia de cache" --provider anthropic
```

`plan`:

```bash
slad plan --input ./docs/log/snapshots/<sessionId>.md --provider gemini
```

`run`:

```bash
slad run --input ./docs/log/plans/<sessionId>.md --task T1 --harness on
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
- En `run`, el estado HITL se representa con `status: "awaiting_human"` y `questions[]`.
- Evitar cambios fuera de scope al actualizar documentación: reflejar sólo lo que existe en código.
