# SLAD Monorepo

SLAD is a pnpm workspace with Turborepo orchestration.

## Packages

- `packages/shared` (`@slad/shared`): Zod schemas, shared TypeScript types, and constants for the SLAD pipeline.
- `packages/cli` (`@slad/cli`): CLI orchestrator for `explore -> snapshot -> plan -> run -> learn -> evolve`.

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
- Turbo builds `@slad/shared` before packages that depend on it.
