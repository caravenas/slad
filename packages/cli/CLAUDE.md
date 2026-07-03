# @slad/cli

Node ESM CLI for the SLAD pipeline: `explore -> snapshot -> plan -> run -> learn -> evolve`.

## Key Paths

- `src/cli.ts`: Commander entry point.
- `src/commands`: one command per pipeline stage plus chat/session commands.
- `src/agents/prompts.ts`: system prompts.
- `src/models`: provider abstraction and vendor adapters.
- `src/core/types.ts`: compatibility bridge. Shared schemas are re-exported from `@slad/shared`; CLI-only schemas remain here.
- `src/core/session.ts`: session state CRUD.

Execution harness and audit logic live in `@slad/harness`, not in this package.

## Commands

```bash
corepack pnpm --filter @slad/cli dev -- explore "intent"
corepack pnpm --filter @slad/cli build
corepack pnpm --filter @slad/cli typecheck
corepack pnpm --filter @slad/cli test
```

## Conventions

- Local ESM imports use `.js` extensions.
- Do not duplicate shared Zod schemas in this package.
- Use `@slad/shared` for serializable agent/session contracts.
- Keep runtime-only types such as `CompletionOptions.onUsage` local.
