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
- `hitl?: HITLTransport` de `@slad/hitl`
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

Esta primera extracción crea el SDK y su boundary público. La migración completa de `@slad/cli` desde `commands/auto.ts` / `commands/run.ts` hacia stages nativos debe hacerse en iteraciones pequeñas para preservar compatibilidad del CLI y del dashboard.
