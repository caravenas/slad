# @slad/ui

Next.js dashboard for SLAD sessions.

## Key Paths

- `src/app`: Next app routes and global CSS.
- `src/components`: dashboard panels and controls.
- `src/lib/data.ts`: typed mock data.
- `src/lib/types.ts`: UI-specific types that extend or reference `@slad/shared` contracts.

## Commands

```bash
corepack pnpm --filter @slad/ui dev
corepack pnpm --filter @slad/ui build
corepack pnpm --filter @slad/ui typecheck
corepack pnpm --filter @slad/ui lint
```

## Conventions

- Import shared stage/session/question/task contracts from `@slad/shared`.
- Keep dashboard-only metrics such as tokens, cost, provider display, and cache hit counts in UI types.
- The UI consumes `@slad/shared` through its package exports; build `@slad/shared` first when running package-level commands directly.
