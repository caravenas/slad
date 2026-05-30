# SLAD Agent Notes

## Architecture

The monorepo has three active packages:

- `@slad/shared`: canonical Zod schemas and inferred types for agent outputs, sessions, questions, plan tasks, run outputs, learn outputs, evolve outputs, and stage constants.
- `@slad/cli`: Node ESM CLI. Local imports keep `.js` extensions. Internal files may still import from `./core/types.js`; that file bridges to `@slad/shared`.
- `@slad/ui`: Next.js dashboard. It imports shared contracts and extends them with UI-only types.

## Rules

- Add or change cross-package data contracts in `packages/shared/src/schemas.ts`.
- Keep CLI-only runtime callbacks, local discovery, project inventory, and project config schemas in `packages/cli/src/core/types.ts`.
- Keep dashboard metrics and mock-display fields in `packages/ui/src/lib/types.ts`.
- Run verification from the root with `corepack pnpm build`, `corepack pnpm typecheck`, and `corepack pnpm test`.
