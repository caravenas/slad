# SLAD — Estructura de carpetas y plan de implementación

> **Estado:** propuesta aprobada para ejecución incremental.
> **Audiencia:** este documento está escrito para ser ejecutado por un agente (Sonnet / Codex / etc.). Cada fase declara objetivo, archivos a tocar, pasos concretos y criterios de aceptación verificables por comando. No avances de fase sin que `corepack pnpm build`, `typecheck` y `test` estén en verde.
> **Decisiones de respaldo:** [ADR-001](./adr/ADR-001-slad-as-agentic-lego-system.md), [ADR-002](./adr/ADR-002-packages-vs-generated-projects.md).

---

## 0. Tesis

SLAD no es un agente: es un **Agent Construction Kit** — un runtime modular para construir agentes seguros, observables y evolutivos a partir de primitivas reutilizables (`defineTool → defineStage → definePipeline → createAgent`).

De ahí la frontera arquitectónica central:

```
packages/            = SDK: primitivas, runtime, contratos, adaptadores reutilizables
blueprints/          = plantillas para GENERAR agentes, tools, stages, pipelines y apps
examples/            = casos de uso oficiales, ejecutables, que LEES
apps/                = productos propios del ecosistema (studio, docs, dashboard, registry)
<proyecto generado>  = agentes y soluciones concretas creadas POR slad (viven fuera del SDK)
```

Un `research-agent` o un `code-review-agent` **nunca** vive en `packages/`. `packages/` contiene capacidades genéricas; las instancias concretas viven en `examples/`, en un domain-kit, o en el proyecto del usuario.

---

## 1. Reality check — punto de partida real del repo

Antes de planificar, el estado verificado del monorepo (no asumir el doc original):

**`packages/` ya está ~90% construido.** Existen y buildean: `agent, audit-log, cache, cli, context-budget, harness, hitl, memory, model-providers, pipeline, shared, telemetry, tools, ui` (14 paquetes).

Respecto al `packages/` objetivo, **solo faltan dos paquetes net-new**: `core/` y `stage/`. Y varias primitivas ya existen en código: `packages/tools/src/define-tool.ts`, `packages/tools/src/context.ts`, `StageContext` y `PipelinePolicies` en `packages/pipeline/src/types.ts`, `@slad/memory` y `@slad/telemetry` con tests.

**Consecuencia para el plan:** esto **no es una migración grande**. El trabajo real es:

1. Aditivo y barato: crear `blueprints/`, `examples/`, `apps/` y ampliar el workspace glob.
2. Un example real que haga *dogfood* del SDK (forcing function de la arquitectura).
3. El generador `slad create` (net-new en el CLI; hoy no existe).
4. Un único split riesgoso —`packages/stage`— que **se difiere** hasta tener un segundo consumidor (ver §3, Principio 5).

El riesgo agregado es bajo. La mayor parte del valor se obtiene sin tocar `packages/`.

---

## 2. Estructura objetivo del repositorio SLAD

```
slad/
├── packages/       # SDK: primitivas, runtime, contratos, adaptadores
├── blueprints/     # Plantillas generativas (agent, tool, stage, pipeline, app)
├── examples/       # Casos de uso oficiales ejecutables
├── apps/           # studio, docs, dashboard, playground, registry
├── docs/           # Arquitectura, ADRs, guías, referencia
├── configs/        # Config compartida del monorepo (tsconfig, eslint, etc.)
├── scripts/        # Automatización interna
└── package.json
```

### 2.1 `packages/` objetivo

```
packages/
├── shared/            # ✅ existe — tipos, schemas, errores, utils serializables
├── agent/             # ✅ existe — defineAgent/createAgent, AgentRuntime
├── pipeline/          # ✅ existe — definePipeline/defineStage/runPipeline, DAG, checkpoints
├── tools/             # ✅ existe — defineTool, ToolRegistry, permisos, ejecución
├── model-providers/   # ✅ existe — OpenAI, Anthropic, Gemini, CLI
├── memory/            # ✅ existe — MemoryStore, wiki memory, in-memory
├── cache/             # ✅ existe — cache de resultados/artefactos
├── context-budget/    # ✅ existe — tokens, costos, límites por ejecución
├── harness/           # ✅ existe — sandbox, approvals, guardrails, permisos
├── hitl/              # ✅ existe — human-in-the-loop gates
├── audit-log/         # ✅ existe — registro trazable append-only
├── telemetry/         # ✅ existe — spans, traces, métricas, exporters
├── cli/               # ✅ existe — CLI como consumidor del runtime
├── ui/                # ✅ existe — componentes reutilizables de UI
├── core/              # ⚠️ NET-NEW — solo si se resuelve la frontera con shared (ver §6)
└── stage/             # ⛔ DIFERIDO — no separar hasta tener 2º consumidor (ver §3)
```

### 2.2 `blueprints/` — plantillas para generar

```
blueprints/
├── agents/    { basic, orchestrator, specialist, coding, research }
├── tools/     { http, mcp, shell, slack, github }
├── stages/    { llm, tool, validation, approval, eval }
└── pipelines/ { sequential, dag, human-review, code-generation }
```

> Las **apps** completas (enterprise-platform, slack-agent-system, etc.) NO van en `blueprints/`. Ver §4, regla de un solo hogar.

### 2.3 `examples/` — referencia ejecutable

```
examples/
├── simple-agent/
├── research-agent/          # ← primer example a construir (dogfood, §5 Fase B)
├── code-review-agent/
├── rag-agent/
├── slack-orchestrator/
├── multi-agent-system/
└── human-in-the-loop-agent/
```

### 2.4 `apps/` — productos del ecosistema

```
apps/
├── docs/        # documentación pública
├── studio/      # UI visual para construir agentes
├── playground/  # sandbox interactivo
├── dashboard/   # runs, traces, evals, costos, auditoría
└── registry/    # catálogo de agents/tools/pipelines/stages
```

---

## 3. Principios de arquitectura (reglas de decisión)

1. **`packages/` contiene capacidades, no agentes concretos.** Viven `defineAgent/defineTool/defineStage/definePipeline`, runtimes, interfaces, contratos, schemas, adaptadores. No `research-agent` ni `dev-agent`.
2. **Cada pieza tiene contrato.** `id`, input schema, output schema, permisos, eventos, riesgos, y tests/evals mínimos (ver §7).
3. **El CLI consume el runtime, no lo contiene.** El pipeline runtime debe correr desde CLI, API, Slack, MCP, dashboard o background worker. El CLI es solo una UI.
4. **Los proyectos generados son aplicaciones de SLAD.** Agentes, prompts, policies, pipelines y tools concretas viven en el proyecto del usuario o en `examples/`, nunca en el SDK base.
5. **Modularizar solo con reutilización real.** Una pieza se promueve a paquete cuando puede probarse aislada **y** usarse en ≥2 agentes/pipelines. *Corolario directo:* `packages/stage` **no se crea ahora** — `defineStage`/`definePipeline` ya conviven en `@slad/pipeline` sin un segundo consumidor que justifique el split.

---

## 4. Frontera SDK ↔ aplicación (regla de un solo hogar)

Cada artefacto tiene **exactamente un hogar**:

| Si la pieza… | Vive en |
|---|---|
| puede usarla cualquier agente (capacidad genérica) | `packages/` |
| representa una solución concreta y ejecutable | `examples/` (o el proyecto del usuario) |
| sirve para **generar** código | `blueprints/` |
| es un producto del ecosistema | `apps/` |

> **Smell a evitar:** el doc original ubicaba `enterprise-agent-platform` simultáneamente en `blueprints/apps/`, `examples/` y `apps/`. Eso confunde. Distinción canónica: *blueprint* = plantilla desde la que generas; *example* = referencia que lees y corres; *app* = producto que envías. Un nombre, un hogar.

---

## 5. Roadmap de ejecución

Orden optimizado para **validar antes de invertir**. Difiere lo riesgoso/caro y adelanta el dogfood.

### Fase A — Decisión estructural (barata, sin tocar `packages/`)

**Objetivo:** fijar la arquitectura por escrito y habilitar el workspace para `examples/` y `apps/`.

Pasos:

1. Crear este documento + [ADR-001](./adr/ADR-001-slad-as-agentic-lego-system.md) y [ADR-002](./adr/ADR-002-packages-vs-generated-projects.md). *(ya hecho con este commit)*
2. Ampliar el workspace glob. En `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - "packages/*"
     - "examples/*"
     - "apps/*"
   ```
3. Marcar `examples/*` y `apps/*` como `"private": true` en su `package.json` para que no se publiquen.
4. (Opcional) Excluir `examples/*` del grafo de build de CI por defecto para mantener CI rápido; correrlos en un job aparte (`turbo run build --filter='./examples/*'`).

**Criterios de aceptación:**
- `corepack pnpm install` resuelve el workspace sin error con los globs nuevos (aunque `examples/`/`apps/` estén vacíos o con un `.gitkeep`).
- `corepack pnpm build && pnpm typecheck && pnpm test` siguen en verde.

### Fase B — Dogfood: primer example real (forcing function)

**Objetivo:** construir `examples/research-agent/` usando **solo** la API pública del SDK. Esto revela si las fronteras de las primitivas son correctas **antes** de invertir en blueprints.

Pasos:

1. Crear `examples/research-agent/` con `package.json` (`private: true`, deps `workspace:*` a `@slad/agent`, `@slad/pipeline`, `@slad/tools`, `@slad/model-providers`, `@slad/harness`).
2. Implementar el agente exclusivamente vía `createAgent` + `definePipeline` + `defineStage` + `defineTool` + `runPipeline`. **Prohibido** importar internals (`@slad/*/src/...` o rutas que no estén en el `exports` del paquete).
3. Documentar en su `README.md` cada punto de fricción encontrado (import que no debería ser interno, contrato que falta, helper ausente). Esta lista es input de la Fase C.

**Criterios de aceptación:**
- `examples/research-agent` corre end-to-end (`pnpm --filter research-agent start` o equivalente) contra un provider real o mock.
- El example **no** importa rutas internas de ningún paquete (verificable con grep: no debe haber `from "@slad/*/src` ni `../../packages`).
- README lista los gaps de DX encontrados.

### Fase C — Estabilizar API pública (a partir de los gaps de la Fase B)

**Objetivo:** convertir lo aprendido en contratos estables y fronteras públicas explícitas, antes de que blueprints y proyectos generados dependan de ellos.

Pasos:

1. En cada `packages/*/package.json`, declarar un `exports` map explícito (qué es público vs interno). Todo lo no listado es interno.
2. Cerrar los contratos mínimos de §7 (`Stage`, `Pipeline`, `Tool`, `StageContext`) y los eventos de §7.4. La mayoría ya existe (`PipelinePolicies`, `StageContext` están en `packages/pipeline/src/types.ts`); el trabajo es alinear nombres y completar huecos detectados en Fase B.
3. Definir política de versionado/compat: qué pasa cuando un contrato cambia (semver de paquetes + nota de breaking change). Documentar en este archivo.

**Criterios de aceptación:**
- Cada paquete público tiene `exports` map; `research-agent` sigue compilando usando solo esos entrypoints.
- Los contratos de §7 existen en `@slad/shared`/`@slad/pipeline`/`@slad/tools` y están re-exportados públicamente.
- `pnpm build/typecheck/test` en verde.

### Fase D — Blueprints mínimos + generador `slad create`

**Objetivo:** ahora sí, templatizar — sobre una API ya validada.

Pasos:

1. Crear blueprints mínimos: `blueprints/agents/basic-agent`, `blueprints/tools/shell-tool`, `blueprints/stages/llm-stage`, `blueprints/pipelines/sequential-pipeline`. Plantillas con placeholders (`{{name}}`, `{{id}}`).
2. Añadir `packages/cli/src/commands/create.ts` → comando `slad create <agent|tool|stage|pipeline|app> <name> [--template <id>]` que copia el blueprint, sustituye placeholders y escribe en el cwd del usuario (no en `packages/`).
3. **Scaffold por niveles (progressive disclosure):** `slad create agent` genera un proyecto mínimo (3–4 carpetas); `--template enterprise` genera el set completo de §8. No imponer 13 carpetas por defecto.

**Criterios de aceptación:**
- `slad create agent demo` genera un proyecto que compila y corre contra el SDK.
- El proyecto generado **no** vive bajo `packages/`; usa `@slad/*` como dependencias publicadas/workspace.
- Existe test del comando `create` (genera a tmp dir, valida estructura mínima).

### Fase E — `apps/` y (si aplica) split de `stage`/`core`

**Objetivo:** construir productos del ecosistema y revisar los splits diferidos solo si ya hay justificación.

Pasos:

1. Iniciar `apps/docs` y `apps/dashboard` consumiendo el runtime (Principio 3).
2. **Reevaluar `packages/stage`:** solo separarlo si en este punto un example o app importa stage sin pipeline (2º consumidor real). Si no, mantenerlo en `@slad/pipeline`.
3. **Reevaluar `packages/core`:** crear solo si la frontera con `shared` quedó nítida (ver §6). Si no, repartir responsabilidades en paquetes existentes.

**Criterios de aceptación:**
- Cada app consume `@slad/*` sin re-implementar runtime.
- Si se hace el split de `stage`: `@slad/pipeline` depende de `@slad/stage`, sin ciclos (`pnpm -r exec madge --circular` o equivalente limpio), build en verde.

---

## 6. `core/` vs `shared/` — resolver antes de crear `core`

`shared/` ya existe (tipos/schemas/errores serializables). Crear un `core/` vago ("runtime base, eventos, contexto") arriesga un segundo paquete-fundación solapado.

**Regla propuesta (a confirmar en Fase E):**
- `@slad/shared` = contratos **serializables**, sin runtime ni IO (schemas Zod, tipos, error codes, constantes).
- `@slad/core` = **runtime** base con lógica (bus de eventos, construcción de contexto de ejecución, utilidades de runtime) que dependa de `shared`.

Si esa frontera no se puede sostener sin solapamiento, **no crear `core`**: mover el bus de eventos/contexto a `@slad/pipeline` o `@slad/agent`.

---

## 7. Contratos técnicos mínimos

> Gran parte ya existe en `packages/pipeline/src/types.ts` (`StageContext`, `PipelinePolicies`, `Stage`, `PipelineDefinition`) y `packages/tools/src/define-tool.ts`. El trabajo es **alinear nombres y completar huecos**, no crear de cero.

### 7.1 Stage

```ts
export interface Stage<I, O> {
  id: string;
  input: Schema<I>;
  output: Schema<O>;
  permissions?: Permission[];
  run(ctx: StageContext, input: I): Promise<O>;
}

export interface StageContext {
  runId: string;
  stageId: string;
  model: ModelProvider;
  tools: ToolRegistry;
  memory?: MemoryStore;
  audit: AuditLog;
  telemetry: TelemetryEmitter;
  budget: BudgetTracker;
}
```

### 7.2 Pipeline

```ts
export interface Pipeline<I, O> {
  id: string;
  version: string;
  input: Schema<I>;
  output: Schema<O>;
  stages: Stage<any, any>[] | PipelineGraph;
  policies?: PipelinePolicies;
}

export interface PipelinePolicies {
  checkpoint?: 'none' | 'after-each-stage' | 'manual';
  resume?: boolean;
  audit?: boolean;
  budget?: boolean;
  humanApproval?: boolean;
}
```

### 7.3 Tool

```ts
export interface Tool<I, O> {
  id: string;
  provider?: string;
  input: Schema<I>;
  output: Schema<O>;
  permissions: Permission[];
  risk: 'low' | 'medium' | 'high';
  requiresApproval?: boolean;
  run(ctx: ToolContext, input: I): Promise<O>;
}
```

### 7.4 Eventos mínimos

```
pipeline.started · pipeline.completed · pipeline.failed · pipeline.resumed
pipeline.stage.started · pipeline.stage.completed · pipeline.stage.failed
checkpoint.saved · checkpoint.loaded
tool.started · tool.completed · tool.failed
approval.requested · approval.granted · approval.rejected
budget.warning · budget.exceeded
```

> **Implementado:** estos nombres viven ahora como contrato tipado en
> `packages/pipeline/src/events.ts` (`PIPELINE_EVENTS` + `PipelineEventName`),
> re-exportado desde `@slad/pipeline`. El runtime aún expone el ciclo de vida de
> stages vía callbacks `onStage*` + spans de telemetría; la constante da a auditoría,
> telemetría y dashboard un único vocabulario al que alinearse.

---

## 8. Estructura de un proyecto generado con SLAD

Generado por `slad create`, **fuera** del SDK. Aplicar progressive disclosure (§5 Fase D).

**Mínimo (`slad create agent`):**
```
my-agent/
├── slad.config.ts
├── agents/
├── tools/
└── README.md
```

**Completo (`--template enterprise`):**
```
my-slad-project/
├── slad.config.ts · package.json · .env.example · README.md
├── agents/ { orchestrator/, specialists/ }
├── tools/ { registry.ts, definitions/, mcp/ }
├── stages/ · pipelines/ · prompts/ · policies/
├── memory/ · runtime/ · api/
├── evals/ · observability/ · tests/ · docs/
```

---

## 9. Checklist de migración

- [x] Fase A: ADRs + `pnpm-workspace.yaml` con `examples/*`, `apps/*`; build verde.
- [x] Fase B: `examples/research-agent` corre sin imports internos; gaps de DX documentados.
- [x] Fase C: `exports` maps por paquete (`@slad/agent` añadido; resto ya los tenía); contratos §7 públicos y alineados (`PIPELINE_EVENTS`); política de versionado escrita (§9bis).
- [x] Fase D: blueprints mínimos + `slad create` con scaffold por niveles + test.
- [x] Fase E: `apps/docs` y `apps/dashboard`; reevaluación de `stage`/`core` con criterio de 2º consumidor (ambos se mantienen diferidos, ver §11).

---

## 9bis. Política de versionado y compatibilidad

Definida en Fase C, una vez que los `exports` maps fijan la frontera público/interno.

**Unidad de versión.** Cada paquete `@slad/*` versiona de forma independiente con
**SemVer**. La superficie pública es *exactamente* lo declarado en el `exports` map de
su `package.json`; todo lo no listado es interno y puede cambiar sin bump mayor.

**Reglas de cambio.**

- **patch** (`x.y.Z`): fixes que no alteran tipos ni contratos (`Stage`, `Pipeline`,
  `Tool`, `StageContext`, `PIPELINE_EVENTS`).
- **minor** (`x.Y.z`): añadidos retrocompatibles — nuevo stage helper, nuevo campo
  opcional en un contrato, nuevo evento en `PIPELINE_EVENTS`, nuevo subpath en `exports`.
- **major** (`X.y.z`): cualquier cambio incompatible — renombrar/eliminar un símbolo
  exportado, volver requerido un campo antes opcional, cambiar la firma de `run()`,
  retirar un nombre de evento. Requiere nota de breaking change.

**Contratos compartidos.** Los contratos serializables (`@slad/shared`) y los del runtime
(`Stage`/`Pipeline`/`Tool`/`StageContext` en `@slad/pipeline` y `@slad/tools`) son los más
sensibles: un cambio mayor en ellos obliga a bump mayor de **todos** los paquetes que los
re-exportan. Por eso §3 Principio 5 difiere splits hasta tener 2º consumidor.

**Breaking changes.** Se registran en el `CHANGELOG` del paquete y, si tocan un contrato
de §7, también en una nota en este documento. Los `examples/*` actúan como canario: si un
cambio rompe `research-agent`, es breaking por definición.

---

## 10. Evals y criterios de aceptación globales

Métricas para validar que la estructura cumple su propósito (reducir fricción idea→ejecución):

- Tiempo para crear un agente funcional nuevo (objetivo: minutos vía `slad create`).
- % de código reutilizado vs nuevo por agente.
- Nº de stages compartidos entre pipelines y tools reutilizadas entre agentes.
- Costo promedio por ejecución.
- Nº de bugs de integración por nuevo agente.
- Nº de decisiones trazadas vía ADRs / audit logs.

**Gate técnico permanente en cada fase:** `corepack pnpm build && pnpm typecheck && pnpm test` en verde.

---

## 11. Riesgos y decisiones abiertas

| # | Decisión abierta | Recomendación de este plan |
|---|---|---|
| R1 | ¿`@slad/stage` separado o dentro de `@slad/pipeline`? | **Dentro de pipeline** hasta tener 2º consumidor (Principio 5). **Decidido en Fase E:** se mantiene diferido — `apps/dashboard`, `apps/docs` y `examples/research-agent` consumen `defineStage` siempre vía `@slad/pipeline`; ningún consumidor importa stage sin pipeline. |
| R2 | ¿`software-dev-kit` como `packages/` o como `examples/code-agent`? | **`examples/`** hasta validar reutilización. |
| R3 | ¿blueprints estáticos o generadores programáticos? | **Estáticos con placeholders** en Fase D; generadores solo si un caso lo exige. |
| R4 | ¿registry como TS API, YAML o ambos? | Decidir en Fase E con datos del catálogo real. |
| R5 | ¿qué parte de observability va en `packages/telemetry` vs `apps/dashboard`? | Instrumentación/contratos en `telemetry`; visualización en `dashboard`. |
| R6 | ¿crear `packages/core`? | Solo si la frontera con `shared` es nítida (§6); si no, no crearlo. **Decidido en Fase E:** no se crea — el runtime (bus de eventos/contexto) vive en `@slad/pipeline`/`@slad/agent` sin solapamiento con los contratos serializables de `@slad/shared`. Reevaluar si aparece lógica de runtime compartida por ≥2 paquetes sin hogar. |

---

## 12. Próximo paso inmediato

Ejecutar **Fase A** (este commit ya incluye los docs/ADRs; falta el cambio de `pnpm-workspace.yaml`) y luego **Fase B** (`examples/research-agent`). No mover el repo entero en un solo cambio: migración incremental, validada con tests en cada fase.
