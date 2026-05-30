# @slad/cli Agent Context

The CLI uses shared contracts from `@slad/shared` and exposes them through `src/core/types.ts` for backward-compatible internal imports.

## Important

- Commands should not import vendor SDKs directly; use `ModelProvider`.
- Agent outputs must validate through their Zod schemas before persistence.
- HITL uses `status: "awaiting_human"` plus `questions[]`.
- The execution harness wraps risky run-phase commands.
- Tests use `node:test` with `node --import tsx/esm --test 'src/**/*.test.ts'`.
