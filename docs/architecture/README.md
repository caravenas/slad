# Arquitectura de SLAD

SLAD es un orquestador de CLIs locales para ejecutar el loop `explore → snapshot → plan → run → learn → evolve`.

## Contrato vigente

- [ADR-004 — SLAD como orquestador de CLIs locales](./adr/ADR-004-cli-orchestrator-runtime-boundary.md) define el propósito, las fronteras y los non-goals vigentes.
- [Plan de refocus de 2026-07-02](../plans/2026-07-02-option-a-refocus.md) documenta la migración que eliminó APIs HTTP, dashboard y micro-paquetes legacy.

## Documentos históricos

ADR-001, ADR-002, ADR-003 y los documentos bajo `legacy-plans/` describen arquitecturas anteriores.
Se conservan únicamente como contexto histórico y quedan reemplazados por ADR-004 ante cualquier contradicción.
No deben utilizarse como especificación de implementación actual.

## Verificación

Todo cambio de runtime debe pasar desde la raíz:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```
