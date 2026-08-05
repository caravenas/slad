# ADR-002 — Separación entre `packages/` y proyectos generados

- **Estado:** Aceptada
- **Fecha:** 2026-06-05
- **Relacionada:** [ADR-001](./ADR-001-slad-as-agentic-lego-system.md), [slad-folder-structure.md](../slad-folder-structure.md)

## Contexto

Dado que SLAD es un Agent Construction Kit (ADR-001), `packages/` no debe mezclar la **fábrica de primitivas** con los **sistemas concretos** construidos con esas primitivas. Mezclar un `research-agent` o un `dev-agent` dentro de `packages/` rompe la frontera del SDK, contamina el grafo de dependencias y vuelve ambiguo qué es API pública.

Estado verificado del repo al momento de esta decisión: `packages/` ya contiene 14 paquetes (`agent, audit-log, cache, cli, context-budget, harness, hitl, memory, model-providers, pipeline, shared, telemetry, tools, ui`). El workspace glob actual es solo `packages/*`. No existen `examples/`, `apps/` ni `blueprints/`, ni el comando `slad create`.

## Decisión

Establecemos una **frontera de un solo hogar** por tipo de artefacto:

| Si la pieza… | Vive en | Naturaleza |
|---|---|---|
| puede usarla cualquier agente (capacidad genérica) | `packages/` | SDK / runtime / contratos |
| representa una solución concreta y ejecutable | `examples/` o el proyecto del usuario | aplicación de SLAD |
| sirve para **generar** código | `blueprints/` | plantilla |
| es un producto del ecosistema | `apps/` | producto (studio, docs, dashboard, registry) |

Reglas derivadas:

1. **`packages/` = capacidades, no agentes concretos.** Solo `define*`, runtimes, interfaces, contratos, schemas, adaptadores.
2. **Los proyectos generados son aplicaciones**, no paquetes del SDK. `slad create` escribe en el cwd del usuario, nunca bajo `packages/`.
3. **Un nombre, un hogar.** Un mismo artefacto no puede vivir a la vez en `blueprints/`, `examples/` y `apps/`. Distinción canónica: *blueprint* = plantilla desde la que generas; *example* = referencia que lees/corres; *app* = producto que envías.
4. **Promoción por reutilización (Principio 5).** Una pieza sube a `packages/` solo cuando puede probarse aislada y la usan ≥2 agentes/pipelines. Corolario: `packages/stage` **no se separa** de `@slad/pipeline` hasta que exista un segundo consumidor real.

## Consecuencias

**Positivas**
- Frontera predecible: cualquier contribuidor (humano o agente) sabe dónde poner cada archivo.
- `packages/` permanece reutilizable y publicable; las soluciones de dominio no contaminan el SDK.
- Permite que `examples/` haga *dogfood* del SDK y actúe como forcing function de la calidad de los contratos.

**Costos / obligaciones**
- Hay que ampliar el workspace (`pnpm-workspace.yaml`: `packages/*`, `examples/*`, `apps/*`) y marcar `examples/*`/`apps/*` como `private`.
- Los `examples/` no deben importar rutas internas de los paquetes; obligan a declarar `exports` maps públicos.
- Mantener CI rápido exige separar el build de `examples/` del build del SDK.

## Alternativas consideradas

1. **Todo en `packages/` (agentes incluidos).** Rechazada: rompe ADR-001 y vuelve ambigua la API pública.
2. **Un repo separado por cada agente concreto.** Rechazada por ahora: fragmenta el dogfooding temprano; `examples/` en el monorepo da feedback más rápido sobre los contratos. Reconsiderable cuando un agente concreto madure como producto independiente.
3. **Split inmediato de `stage`/`core`.** Rechazada: viola el Principio 5 (sin 2º consumidor); se difiere a una reevaluación posterior.
