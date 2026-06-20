# @slad/app-dashboard

Ecosystem app that renders pipeline **runs and traces**. It consumes `@slad/pipeline`
directly (Principle 3 — the runtime runs outside the CLI) and never re-implements the
runtime. The runs view is keyed off the canonical `PIPELINE_EVENTS` vocabulary.

```bash
corepack pnpm --filter @slad/app-dashboard start
```
