# @slad/pipeline

SDK incremental para ejecutar pipelines deterministas de SLAD sin depender del runtime del CLI.

## API pública

- `Stage<Input, Output>`: contrato genérico de etapa con `id`, `run(input, ctx)` y cache opcional.
- `defineStage(stage)`: helper tipado para declarar etapas reusables.
- `definePipeline(definition)`: helper tipado para declarar pipelines con etapas inline o referencias por id.
- `runPipeline(options)`: runner secuencial que conecta servicios compartidos, artifacts, eventos y cache.

## Servicios conectados

`PipelineServices` expone puntos de integración para los paquetes extraídos en fases previas:

- `provider?: ModelProvider` de `@slad/model-providers`
- `harness?: ExecutionHarness` de `@slad/harness`
- `hitl?: HITLTransport` de `@slad/hitl` para consumidores externos; los stages autónomos no lo usan
- `tools?: ToolRegistry` de `@slad/tools`
- `cache?: CacheStore<unknown>` de `@slad/cache`

## Ejemplo

```ts
import { definePipeline, defineStage, runPipeline } from "@slad/pipeline";

const analyze = defineStage<string, { summary: string }>({
  id: "analyze",
  cache: true,
  async run(input, ctx) {
    await ctx.emitArtifact("raw-intent", input);
    return { summary: input.trim() };
  },
});

const pipeline = definePipeline({
  id: "custom-slad-flow",
  stages: [analyze],
});

const result = await runPipeline({ ...pipeline, input: "Build a feature" });
```

## Alcance de esta extracción

Los stages nativos son autónomos: convierten preguntas no resueltas en assumptions, open questions o follow-ups, en vez de pausar el pipeline para HITL.
La aprobación humana del plan pertenece al límite del CLI antes de ejecutar `run`, no a un stage del pipeline.
