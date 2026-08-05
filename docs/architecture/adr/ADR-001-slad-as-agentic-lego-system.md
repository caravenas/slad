# ADR-001 — SLAD como Agentic Lego System (Agent Construction Kit)

- **Estado:** Aceptada
- **Fecha:** 2026-06-05
- **Relacionada:** [ADR-002](./ADR-002-packages-vs-generated-projects.md), [slad-folder-structure.md](../slad-folder-structure.md)

## Contexto

SLAD nació como un CLI orchestrator con un pipeline determinista `explore → snapshot → plan → run → learn → evolve`, donde cada stage produce JSON validado por Zod que el siguiente consume. A medida que el sistema crece, surge la pregunta de identidad: ¿SLAD es **un agente** (una solución) o **una fábrica de agentes** (un SDK)?

La respuesta determina dónde vive el código, qué se considera API pública y cómo escala el repositorio. Si SLAD es "un agente", todo puede mezclarse. Si es "una fábrica", debe existir una frontera dura entre las primitivas reutilizables y las soluciones construidas con ellas.

El monorepo ya expone primitivas componibles: `defineTool → defineStage → definePipeline → createAgent`, con un runtime de pipeline (cache, checkpoints, artifacts, eventos), harness de seguridad, HITL, audit-log, memory, telemetry y context-budget. Es decir, ya **se comporta** como un kit de construcción.

## Decisión

Tratamos SLAD como un **Agent Construction Kit**: un runtime modular para construir agentes seguros, observables, componibles y evolutivos a partir de primitivas reutilizables.

Conceptualmente:

```
Agent = Pipeline + Stages + Tools + Models + Memory + Harness + Telemetry + Evals
```

Capas del sistema:

- **Kernel:** models, tools, harness, budget, audit, cache, memory, HITL, telemetry.
- **Pipeline Runtime:** stages, checkpoints, events, resume.
- **Domain Kits:** software-dev, research, product, data, ops (instancias de dominio).
- **Applications:** CLI, dashboard, API, MCP, web UI.

Las primitivas se ensamblan para crear agentes especializados y reutilizables; SLAD no es el agente, es lo que permite construirlo.

## Consecuencias

**Positivas**
- Da un criterio único para decidir dónde va cada pieza (capacidad genérica vs solución concreta).
- Habilita escalar por composición y reutilización, no por acumulación de features.
- Convierte los contratos de las primitivas en API pública con responsabilidad de estabilidad.

**Costos / obligaciones**
- Obliga a mantener una frontera dura SDK ↔ aplicación (detallada en ADR-002).
- Exige disciplina de contratos (id, input/output schema, permisos, eventos, riesgos, tests) en cada primitiva.
- Requiere versionado/compat explícito porque blueprints y proyectos generados dependerán de esos contratos.

## Alternativas consideradas

1. **SLAD como aplicación monolítica (un agente).** Rechazada: bloquea la reutilización y mezcla soluciones de dominio con el runtime.
2. **SLAD como framework sin generación.** Rechazada parcialmente: pierde la propuesta de valor de reducir fricción idea→ejecución vía scaffolding (`slad create`).
