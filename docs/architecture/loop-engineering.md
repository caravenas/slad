# SLAD — Loop Engineering (bucle de ingeniería)

> Historical design proposal. Its HITL escalation references the pre-autonomous pipeline and does not describe the current plan-approval gate.

> **Estado:** propuesta para ejecución incremental.
> **Audiencia:** este documento está escrito para ser ejecutado por un agente. Cada fase declara objetivo, archivos a tocar, pasos concretos y criterios de aceptación verificables por comando. No avances de fase sin que `corepack pnpm build`, `typecheck` y `test` estén en verde.
> **Decisión de respaldo:** [ADR-003](./adr/ADR-003-loop-engineering-closed-loop.md). Boundary SDK: [ADR-001](./adr/ADR-001-slad-as-agentic-lego-system.md).

---

## 0. Tesis

El pipeline SLAD ya tiene **todas las etapas** de un bucle de ingeniería (`explore → snapshot → plan → run → learn`), pero las corre **una sola vez**. Loop Engineering no añade etapas nuevas: añade el **controlador que cierra el lazo** — un evaluador que decide *"¿meta cumplida? no → re-entrar con memoria de los intentos previos"*.

```
Método actual (lineal):   intent → explore → snapshot → plan → run → learn → fin
Loop Engineering (cerrado): intent → [ explore → snapshot → plan → run → learn → verify ]↺  → accept | escalate | exhaust
                                       └──────────── memoria de intentos previos ───────────┘
```

El bucle **envuelve** `runPipeline` (`packages/pipeline/src/runner.ts`); no lo modifica. Esto respeta el boundary SDK ([ADR-001](./adr/ADR-001-slad-as-agentic-lego-system.md)) y evita reconstruir stages.

---

## 1. Reality check — sustrato ya disponible

Verificado contra el repo (no asumir). El runtime ya provee lo que el bucle necesita:

| Necesidad del bucle | Ya existe en el repo |
|---|---|
| Ejecutor lineal de stages con validación Zod | `runPipeline` / `runSladPipeline` (`packages/pipeline/src/runner.ts`, `slad-runner.ts`) |
| Tope de presupuesto (closed loop) | `PipelinePolicies.budget` → `maxModelCalls`, `maxUsd` (enforced en el runner) |
| Cache content-based entre stages | `StageCacheConfig` + `readCached/writeCached` en el runner |
| Estado cross-stage | `StageContext.state: Map<string, unknown>` |
| Memoria persistente por namespace | `MemoryProvider` (`@slad/memory`): `append / query / clear` |
| Señal objetiva de éxito | `RunOutput.verification[].status` (`passed`/`failed`/…) y `PlanTask.acceptanceCriteria` (min 1) |
| Gate de decisiones irreversibles | `runDecisionGate` (`packages/cli/src/core/decision-gate.ts`) |
| Eventos/telemetría | `PIPELINE_EVENTS` (`packages/pipeline/src/events.ts`) |

**Consecuencia:** esto es aditivo y barato. El trabajo neto es un contrato (`GoalVerdict`), una stage (`verify`), un módulo driver (`loop/`) y una superficie CLI. **Nada del núcleo se modifica.**

---

## 2. Contrato del veredicto — `GoalVerdict`

Vive en `@slad/shared` (`packages/shared/src/schemas.ts`), junto a los demás contratos serializables. Es el "agente de control" de la práctica, validado por Zod como cualquier otro artifact — coherente con la invariante "cada stage produce JSON validado".

```ts
export const GoalGap = z.object({
  description: z.string(),
  severity: z.enum(["blocker", "major", "minor"]),
  relatedTaskId: TaskId.optional(),
});
export type GoalGap = z.infer<typeof GoalGap>;

export const GoalVerdict = z.object({
  satisfied: z.boolean(),
  confidence: z.number().min(0).max(1),
  gaps: z.array(GoalGap).default([]),
  evidence: z.array(z.string()).default([]),        // acceptanceCriteria / verification cumplidos
  recommendation: z.enum(["accept", "retry", "escalate"]),
  rationale: z.string(),
});
export type GoalVerdict = z.infer<typeof GoalVerdict>;
```

---

## 3. La stage de verificación — `verifyStage`

Archivo nuevo: `packages/pipeline/src/stages/verify.ts`. Consume `RunOutput[]` + la meta original (`intent` + los `acceptanceCriteria` del plan). **Determinista primero, LLM después:**

1. **Pre-check objetivo (sin model call):**
   - ¿Todos los `RunOutput.verification[].status === "passed"`?
   - ¿Cada `PlanTask.acceptanceCriteria` está cubierto por evidencia?
   - Si algún `verification` está en `failed` → `satisfied: false`, `recommendation: "retry"`, sin gastar tokens.
2. **Solo si la señal objetiva es ambigua**, llama al modelo:
   `ctx.model.generateObject({ schema: GoalVerdict, system, input })` para juzgar satisfacción semántica.

Como es una stage real, hereda cache y validación de `outputSchema` gratis. Patrón a seguir: `packages/pipeline/src/stages/learn.ts`.

```ts
export const verifyStage = defineStage<RunOutput[], GoalVerdict, SladServices>({
  id: "verify",
  description: "Evalúa si el resultado cumple la meta (determinista → LLM)",
  inputSchema: z.array(RunOutput) as z.ZodType<RunOutput[]>,
  outputSchema: GoalVerdict as z.ZodType<GoalVerdict>,
  permissions: ["read"],
  cache: { enabled: false },
  async run(input, ctx) {
    const objective = evaluateObjective(input, ctx.state.get("plan") as PlanOutput | undefined);
    if (objective.decisive) return objective.verdict;        // sin model call
    const verdict = await ctx.model.generateObject({
      schema: GoalVerdict as z.ZodType<GoalVerdict>,
      system: ctx.services.prompts?.builderReviewer ?? DEFAULT_VERIFY,
      input: `Goal:\n${...}\n\nRun results:\n${JSON.stringify(input, null, 2)}`,
      temperature: 0.1,
    });
    await ctx.emitArtifact("verify", verdict);
    return verdict;
  },
});
```

---

## 4. Ledger de intentos — reutiliza `MemoryProvider`

Sin persistencia nueva. `ctx.services.memory` ya expone `append / query / clear` por namespace. Un namespace por meta: `loop:<hash(intent)>`. Cada iteración:

```ts
await memory.append({
  namespace: ns,
  content: { iteration, verdict, gaps: verdict.gaps, learnSummary, changedFiles, planSummary },
});
```

En la vuelta siguiente, `planStage` hace `memory.query({ namespace: ns })` e inyecta los intentos previos en el system prompt del planner: *"no repitas estos fallos; corrige estos gaps"*. Esto materializa la pieza central de la práctica: **reiniciar el ciclo usando la memoria de los intentos previos**.

---

## 5. El driver — `runLoop`

Archivo nuevo: `packages/pipeline/src/loop/index.ts`. Envuelve `runSladPipeline`.

```ts
export interface LoopOptions extends SladPipelineOptions {
  maxIterations?: number;          // default 3
  mode?: "closed" | "open";        // default "closed"
}
export interface LoopResult {
  outcome: "accepted" | "escalated" | "stalled" | "exhausted";
  iterations: number;
  verdict: GoalVerdict;
  pipeline: SladPipelineResult;
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const ns = `loop:${hash(opts.intent ?? "")}`;
  const maxIterations = opts.mode === "open" ? (opts.maxIterations ?? Infinity) : (opts.maxIterations ?? 3);
  let attempt = 0, prevGapsHash = "";

  while (attempt < maxIterations) {
    const stages = attempt === 0
      ? ["explore", "snapshot", "plan", "run", "learn", "verify"]
      : ["plan", "run", "learn", "verify"];          // re-entry: explore/snapshot salen del cache

    const priorAttempts = await opts.memory.query({ namespace: ns });
    const pipeline = await runSladPipeline({ ...opts, stages,
      initialInput: { intent: opts.intent, priorAttempts },
    });
    const verdict = pipeline.outputs.verify as GoalVerdict;

    if (verdict.satisfied || verdict.recommendation === "accept")
      return { outcome: "accepted", iterations: attempt + 1, verdict, pipeline };
    if (verdict.recommendation === "escalate")
      return { outcome: "escalated", iterations: attempt + 1, verdict, pipeline };  // → HITL

    await opts.memory.append({ namespace: ns, content: { attempt, verdict } });

    // Anti-bucle-abierto: si los gaps no cambian, no hay progreso → no quemes otra iteración.
    const gapsHash = hash(verdict.gaps);
    if (gapsHash === prevGapsHash)
      return { outcome: "stalled", iterations: attempt + 1, verdict, pipeline };
    prevGapsHash = gapsHash;
    attempt++;
  }
  return { outcome: "exhausted", iterations: attempt, verdict: lastVerdict, pipeline: lastPipeline };
}
```

**Re-entry barato:** la 1ª iteración corre el pipeline completo; las siguientes entran en `plan` porque `explore`/`snapshot` se sirven del cache content-based (el `intent` es fijo). Evita re-explorar en cada vuelta.

---

## 6. Garantías de cierre (closed vs open)

Estas tres garantías son lo que hace al bucle **cerrado** y lo distingue del open loop que "quema tokens y presupuesto":

1. **`maxIterations`** — tope duro de vueltas (default 3 en modo `closed`).
2. **Presupuesto existente** — `PipelinePolicies.budget` (`maxUsd` / `maxModelCalls`) ya lo enforcea `runPipeline`; el loop solo lo acumula entre iteraciones. No se toca el runner.
3. **Detección de estancamiento** — si `verdict.gaps` es idéntico (por hash) al de la vuelta previa, no hay progreso → se escala a HITL en lugar de gastar otra iteración.

`mode: "open"` relaja (1), bajo responsabilidad explícita del usuario; (2) y (3) siguen activos salvo que el presupuesto se omita.

---

## 7. Integración con el resto del sistema

- **`decision-gate.ts`**: ya bloquea decisiones `hard`/`permanent` por stage. El loop trata un `"paused"` del gate como razón de salida; las decisiones irreversibles nunca se ejecutan en piloto automático dentro del bucle.
- **`evolve`** (comando, no stage): se mantiene como meta-paso **post-loop**. Ahora recibe el **ledger completo de intentos** en vez de un solo pase → propone mejores ajustes de prompts/políticas. Loop Engineering hace a `evolve` más útil, no lo reemplaza.
- **Eventos**: emitir `loop.iteration.started` / `loop.iteration.completed` / `loop.converged` vía `ctx.audit.emit` siguiendo el patrón de `PIPELINE_EVENTS` (`packages/pipeline/src/events.ts`).

---

## 8. Superficie de uso

**CLI** (junto a los subcomandos `pipeline`):

```bash
slad pipeline loop "<intent>" [--max-iterations 3] [--budget-usd N] [--mode closed|open]
```

**Kit** (vía `createAgent`):

```ts
createAgent({ pipeline: buildSladPipeline({...}), loop: { maxIterations: 3, mode: "closed" } });
```

---

## 9. Plan de implementación incremental

### Fase 1 — Slice mínimo viable
**Objetivo:** cerrar el lazo con topes duros, sin tocar el núcleo.

**Archivos:**
- `packages/shared/src/schemas.ts` — añadir `GoalGap`, `GoalVerdict` (+ export en `index.ts`).
- `packages/pipeline/src/stages/verify.ts` — `verifyStage` (pre-check objetivo + fallback LLM).
- `packages/pipeline/src/stages/index.ts` — exportar `verifyStage`.
- `packages/pipeline/src/loop/index.ts` — `runLoop` con `maxIterations` + detección de estancamiento.
- `packages/pipeline/src/index.ts` — exportar `runLoop`, `LoopOptions`, `LoopResult`.
- Tests: `verify.test.ts`, `loop.test.ts` (con mock provider).

**Criterios de aceptación (verificables por comando):**
- `corepack pnpm build` y `corepack pnpm typecheck` en verde.
- `corepack pnpm --filter @slad/pipeline test` en verde, incluyendo:
  - un test donde `verification` falla → `verdict.satisfied === false` **sin** invocar el provider (asserción sobre el contador de llamadas del mock).
  - un test de estancamiento: dos iteraciones con gaps idénticos → `outcome === "stalled"`.
  - un test de éxito: `verdict.satisfied === true` en la 1ª vuelta → `outcome === "accepted"`, `iterations === 1`.
- `GoalVerdict` validado en `packages/shared/src/schemas.test.ts`.

### Fase 2 — Memoria de intentos
**Objetivo:** que el plan de cada vuelta use los fallos previos.

**Archivos:**
- `packages/pipeline/src/loop/index.ts` — `append`/`query` al `MemoryProvider` con namespace `loop:<hash>`.
- `packages/pipeline/src/stages/plan.ts` — inyectar `priorAttempts` del input en el system prompt del planner.

**Criterios de aceptación:**
- Test: tras una iteración fallida, el input del `planStage` de la 2ª vuelta contiene los gaps de la 1ª (asserción sobre el prompt/input capturado por el mock).
- `corepack pnpm --filter @slad/pipeline test` en verde.

### Fase 3 — Superficie CLI + eventos
**Objetivo:** comando `slad pipeline loop` y telemetría.

**Archivos:**
- `packages/cli/src/commands/` — comando `loop` bajo el parent `pipeline`.
- `packages/pipeline/src/events.ts` — añadir nombres `loop.*` al taxonomy.
- emisión vía `ctx.audit.emit`.

**Criterios de aceptación:**
- `slad pipeline loop "<intent>" --max-iterations 1 --mode closed` corre end-to-end en dry-run.
- Los eventos `loop.*` aparecen en el audit log.
- `corepack pnpm build && corepack pnpm typecheck && corepack pnpm test` en verde.

### Diferido (no en este plan)
- **Ejecución en paralelo de specialists** (fan-out de agentes). El runner es secuencial; es un cambio mayor e independiente. El bucle entrega la mayor parte del valor sin él.

---

## 10. Resumen en una línea

SLAD ya tenía todas las etapas del bucle pero las corría una vez; Loop Engineering cierra el lazo con un veredicto Zod, memoria de intentos reutilizando `@slad/memory`, y tres topes que lo mantienen **cerrado** — todo envolviendo `runPipeline` sin modificar su núcleo.
