# Plan de Modularización — SLAD

> Pipeline determinista `explore → snapshot → plan → run → learn → evolve` para orquestación de AI agents en software development.

## Estado actual

SLAD es un monorepo pnpm/Turborepo con 3 paquetes:

- **`@slad/shared`** — Zod schemas, constants, error codes. Ya está limpio, no tocar.
- **`@slad/cli`** — Orquestador (~12.4K LOC en src/). Contiene 8–10 subsistemas independientes mezclados.
- **`@slad/ui`** — Dashboard Next.js que hoy spawnea CLI como subprocess vía RPC.

El problema: `@slad/cli` concentra lógica reusable (cache, providers, harness, HITL) acoplada a primitivas de terminal (ora, kleur, `@inquirer/prompts`, `process.stdin.isTTY`, `child_process`). Esto impide reusar el core en otros proyectos y obliga al UI a pasar por subprocess.

### Archivos más pesados (señal de acoplamiento)

| Archivo | LOC | Problema |
|---|---|---|
| `commands/run.ts` | 1209 | Mezcla lógica de pipeline con ora/kleur/process.exit |
| `commands/auto.ts` | 872 | Importa 20+ módulos internos, orquesta todo el pipeline |
| `models/cli.ts` | 711 | Provider adapter, ya desacoplado |
| `agents/prompts.ts` | 433 | Data pura, no IO — extraíble trivialmente |
| `core/inventory.ts` | 378 | Introspección del proyecto |

---

## Principio rector

Modularizar por **nivel de acoplamiento al CLI**, no por tipo de refactor. Esto predice el esfuerzo real y el reuso que se obtiene.

---

## Fase 1 — Extracción barata (1–2 días)

Paquetes que ya no tienen dependencias al runtime del CLI. Son casi copy-paste.

### `@slad/cache`

- **Origen:** `cli/src/cache/` (store.ts 274L, keys.ts, reusable.ts, invalidation.ts)
- **Qué es:** Content-hash store con invalidación. Persiste en `.slad-os/cache/`.
- **Por qué se extrae:** No sabe nada del dominio "software dev pipeline". Es una primitiva universal para cualquier pipeline de IA (RAG, batch jobs, agentes).
- **Dependencias:** Solo `@slad/shared` para tipos base.
- **Tests:** Ya tiene tests propios (store.test.ts, keys.test.ts, invalidation.test.ts).

### `@slad/audit-log`

- **Origen:** `cli/src/harness/audit.ts`
- **Qué es:** LDJSON append-only writer con batching.
- **Por qué se extrae:** Sirve para auditar cualquier sistema de agentes. Se saca de `harness/` porque es una primitiva independiente del clasificador y del approval flow.
- **Dependencias:** Solo `@slad/shared`.

### `@slad/context-budget`

- **Origen:** `cli/src/context/budget.ts` + `budget-history.ts` + `types.ts`
- **Qué es:** Token counting + cost tracking por sesión.
- **Por qué se extrae:** Otra primitiva universal. Cualquier aplicación que consuma LLMs necesita tracking de costo.
- **Tests:** budget.test.ts, budget-history.test.ts.

### Checkpoint de fase

```bash
pnpm --filter @slad/cli build   # sigue verde
pnpm --filter @slad/cache test  # tests aislados pasan
pnpm --filter @slad/audit-log test
pnpm --filter @slad/context-budget test
```

---

## Fase 2 — `@slad/model-providers` (2–3 días)

El paquete de mayor reuso futuro. Es el que vas a importar en **todos** tus proyectos de IA.

### `@slad/model-providers`

- **Origen:** `cli/src/models/` (index.ts, anthropic.ts, openai.ts, gemini.ts, cli.ts, retry.ts, timeout.ts, tool-loop.ts, cli-discovery.ts)
- **Qué es:** Adaptador multi-vendor detrás de una sola interfaz `ModelProvider`. Factory con dynamic imports por provider.
- **Por qué se extrae:** Boundaries ya claros. `ModelProvider` interface + factory + retry/timeout son genéricos. El único acoplamiento es `CompletionOptions` en `core/types.ts`, que se mueve a shared o al propio paquete.
- **Decisión importante:** Dynamic imports por provider — solo se carga el SDK del que el usuario use. Esto baja el install de ~80MB a algo razonable para distribución pública.
- **Dependencias:** `@slad/shared` para tipos.
- **Tests:** retry.test.ts, timeout.test.ts, tool-loop.test.ts, cli-discovery.test.ts.

### Checkpoint de fase

```typescript
// Debe funcionar standalone en un repo nuevo:
import { getProvider } from "@slad/model-providers";
const provider = await getProvider("anthropic", process.env.ANTHROPIC_API_KEY);
const response = await provider.complete([{ role: "user", content: "hello" }]);
```

---

## Fase 3 — Refactor de interfaces (3–5 días)

La fase estratégica. Define interfaces que desacoplan la lógica del terminal. Esto habilita Agentic UI: el dashboard deja de ser wrapper RPC y se convierte en consumer de primera clase.

### `@slad/hitl`

- **Origen:** `cli/src/core/hitl.ts` + `hitl-loop.ts` + `hitl-auto-resolve.ts`
- **Qué es:** Protocolo Question/Answer para human-in-the-loop.
- **Problema actual:** Atado a `process.stdin.isTTY` y `@inquirer/prompts`.
- **Refactor:** Definir `HITLTransport` interface con 2 implementaciones:
  - `TTYTransport` — mueve `@inquirer/prompts` aquí (es lo que existe hoy)
  - `HTTPTransport` — para `@slad/ui` vía WebSocket
- **Por qué importa:** Esto es **clave** para la visión de Agentic UI. Una vez el UI tiene su propio transport, deja de ser wrapper y pasa a ser consumer directo del pipeline.
- **Dependencias:** `@slad/shared`.

### `@slad/harness`

- **Origen:** `cli/src/harness/` (index.ts, classifier.ts, approval.ts, config.ts, types.ts)
- **Qué es:** Safety harness — clasificador read/workspace/full + approval flow + pre/post hooks.
- **Problema actual:** `approval.ts` llama a `@inquirer/prompts` directamente.
- **Refactor:** Definir `ApprovalIO` interface. El harness ya tiene factory + hooks pattern, solo falta abstraer la capa de IO. Después puedes plugar approval por CLI, web, Slack, lo que sea.
- **Dependencias:** `@slad/shared`, `@slad/audit-log`.
- **Tests:** classifier.test.ts, audit.test.ts.

### `@slad/tools`

- **Origen:** `cli/src/tools/` (executor.ts 100L, registry.ts, types.ts, definitions/{filesystem,shell,git}.ts)
- **Qué es:** Tool executor + registry + definiciones de herramientas para agentes.
- **Problema actual:** `executor.ts` usa `child_process` y `fs` directamente.
- **Refactor:** Abstraer `Shell` y `FileSystem` como interfaces:
  - `LocalShell` / `LocalFS` — implementación actual
  - Queda abierto para sandbox, contenedor, ejecución remota
- **Dependencias:** `@slad/shared`.
- **Tests:** executor.test.ts, filesystem.test.ts, shell.test.ts.

### Checkpoint de fase

```typescript
// @slad/ui puede importar directamente sin subprocess:
import { createHitlTransport } from "@slad/hitl";
const transport = createHitlTransport("http", { wsUrl: "ws://localhost:3001" });
```

---

## Fase 4 — `@slad/pipeline` (1–2 semanas)

La apuesta arquitectónica. SLAD deja de ser un CLI con stages hardcodeados y pasa a ser **un uso** de un pipeline runner genérico.

### `@slad/pipeline` (SDK)

- **Origen:** Stage runner extraído de `commands/*` + `agents/`
- **Qué es:** Contrato `Stage<Input, Output>` parametrizable + `defineStage` + `runPipeline`.
- **API objetivo:**
  ```typescript
  import { runPipeline, defineStage } from "@slad/pipeline";
  import { getProvider } from "@slad/model-providers";
  import { createHarness } from "@slad/harness";

  await runPipeline({
    stages: ["explore", "plan", "run"],
    provider: getProvider("anthropic"),
    harness: createHarness({ approvalIO: myWebApproval }),
    hitl: myHTTPTransport,
    onArtifact: (stage, artifact) => db.save(stage, artifact),
  });
  ```
- **Por qué importa:** Posiciona SLAD como plataforma para construir agentes, no solo como herramienta. Conecta directo con la visión de AI Systems Builder.
- **Dependencias:** `@slad/shared`, `@slad/cache`, `@slad/model-providers`, `@slad/harness`, `@slad/hitl`, `@slad/tools`.

### Resultado: CLI slim + UI directa

- **`@slad/cli`** se reduce a: `cli.ts` (commander + arg parsing), `commands/*.ts` (thin wrappers de 20–40L cada uno), `cli/ui.ts` (ora/kleur), `agents/prompts.ts` (los prompts son el producto).
- **`@slad/ui`** importa `@slad/pipeline` directamente. Elimina `slad-server.ts` (subprocess layer). Usa `HTTPTransport` para HITL vía WebSocket.

### Checkpoint de fase

```typescript
// Definir un pipeline custom sin tocar @slad/cli:
const myPipeline = definePipeline({
  stages: [analyzeStage, transformStage, validateStage],
  cache: createCache({ dir: ".my-cache" }),
});
```

---

## Dependency graph objetivo

```
                    ┌─────────────────────────────┐
                    │        @slad/shared          │
                    │   (Zod schemas, constants)    │
                    └──────────────┬──────────────┘
                                   │
        ┌──────────┬───────────┬───┴───┬──────────┐
        │          │           │       │          │
  ┌─────┴───┐ ┌────┴─────┐ ┌──┴───┐ ┌─┴────────┐ ┌┴─────────┐
  │  cache  │ │ audit-log│ │model-│ │ context- │ │  tools   │
  │         │ │ (.ldjson)│ │provs │ │  budget  │ │(fs/shell)│
  └────┬────┘ └────┬─────┘ └──┬───┘ └────┬─────┘ └────┬─────┘
       │           │          │          │             │
       └───────────┴──────────┴──────────┴─────────────┘
                              │
                   ┌──────────┴──────────┐
                   │    @slad/harness    │
                   │  ApprovalIO iface   │
                   └──────────┬──────────┘
                              │
                   ┌──────────┴──────────┐
                   │     @slad/hitl      │
                   │  HITLTransport iface│
                   └──────────┬──────────┘
                              │
                   ┌──────────┴──────────┐
                   │   @slad/pipeline    │
                   │  Stage<I,O> runner  │
                   └──────────┬──────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
         ┌──────┴──────┐            ┌───────┴──────┐
         │  @slad/cli  │            │   @slad/ui   │
         │ TTYTransport│            │ HTTPTransport│
         └─────────────┘            └──────────────┘
```

Regla: una flecha hacia abajo = "no puede importarme nadie de abajo". Cada paquete se publica independientemente.

---

## Lo que NO se modulariza

- **`commands/*`** — Son el wiring específico de SLAD, no primitivas reusables.
- **`agents/prompts.ts`** — Los prompts son el producto; vale más mantenerlos versionados junto al CLI.
- **`core/classifier.ts`** — Lógica de dominio (ask/work/work-debate routing).
- **`cli/ui.ts`** — Adornos de terminal (ora/kleur).

---

## Estrategia de publicación

1. Los paquetes internos (`@slad/cache`, `@slad/hitl`, etc.) salen como `private: true` en package.json con `workspace:*`. No se publican a npm hasta que el SDK esté listo.
2. Solo `@slad/cli` y `@slad/shared` van a npm en la primera release.
3. Todo sale como `0.x.x` — semver permite breaking changes antes de 1.0.
4. Cuando `@slad/pipeline` esté validado con uso real, ambos (CLI + SDK) saltan a `1.0` juntos.

## Decisiones pendientes

- **Nombre del scope npm.** Verificar disponibilidad de `@slad` o decidir rename (Movimiento A: find-replace in-place, no repo nuevo).
- **Layout de filesystem versionado.** Definir qué va en `.slad-os/` del proyecto vs `~/.slad/` del usuario. Meter `schemaVersion` en cada artifact JSON desde v0.1.
- **Env vars con prefijo.** `SLAD_ANTHROPIC_API_KEY`, `SLAD_PROVIDER`, etc. Cambiar nombres después es muy molesto para usuarios.
