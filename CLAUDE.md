# SLAD Monorepo

SLAD is a pnpm workspace with Turborepo orchestration.

## Packages

- `packages/shared` (`@slad/shared`): Zod schemas, shared TypeScript types, and constants for the SLAD pipeline.
- `packages/model-providers` (`@slad/model-providers`): `ModelProvider` seam + `CliProvider` (spawns agent CLI binaries) + `ModelAdapter` (`generateObject` / `generateText`).
- `packages/tools` (`@slad/tools`): `defineTool()`, `ToolRegistry`, builtin tools.
- `packages/harness` (`@slad/harness`): execution harness — command classification, hooks, `assertPermission()`, LDJSON audit log.
- `packages/hitl` (`@slad/hitl`): human-in-the-loop transports (TTY, none).
- `packages/cache` (`@slad/cache`): stage output cache.
- `packages/pipeline` (`@slad/pipeline`): `defineStage`, `runPipeline`, `buildSladPipeline`, the SLAD stages, `createAgent()`, memory/telemetry providers, budget tracking.
- `packages/cli` (`@slad/cli`): CLI orchestrator for `explore -> snapshot -> plan -> run -> learn -> evolve`.

`examples/research-agent` shows SDK usage; `blueprints/` backs `slad create`.

## Commands

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm dev:cli -- explore "intencion"
corepack pnpm --filter @slad/cli test
```

## Conventions

- Shared serializable contracts live in `packages/shared/src`, not in `packages/cli/src/core/types.ts`.
- `packages/cli/src/core/types.ts` is a compatibility bridge: it re-exports shared schemas and keeps CLI-only runtime/config schemas.
- Workspace dependencies use `workspace:*`.
- Turbo builds dependencies before dependents (`^build`); `typecheck` needs no build — package `exports` point `types` at `./src/index.ts`, so types resolve from source.
- Packages do not use TypeScript project references or `composite`; new packages must follow the `types: ./src/index.ts` exports pattern.
