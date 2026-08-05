# Patrones learn MD

## Summary
Debe evolucionar la documentación de pruebas y artifacts para registrar el patrón confirmado: learnCommand consume artifacts run Markdown+YAML mediante parseRun, mantiene compatibilidad legacy JSON, y los tests de comandos LLM/HITL deben usar provider fake, fixtures temporales y assertions semánticas.

## Proposed Updates
### docs/wiki/testing-llm-hitl-commands.md
Change: create
Rationale: Los runs T2-T5 y el learning T5 confirman un patrón repetible para probar comandos que dependen de ModelProvider, sesión activa y artifacts persistidos sin usar red ni vendors reales.

```markdown
# Testing LLM/HITL Commands

## Pattern
Para tests de comandos que invocan agentes o providers, usar `ModelProvider` fake y fixtures temporales de proyecto/sesión.

## Guidelines
- Invocar el comando por el entrypoint más cercano al flujo real, con opciones inyectadas para `modelProvider` y `cwd` cuando existan.
- Crear artifacts reales con los renderers del proyecto y validarlos con los parsers/readers del flujo de persistencia.
- Evitar llamadas reales a SDKs, red o providers configurados.
- Capturar `messages` del provider fake y verificar datos semánticos relevantes, no snapshots completos del prompt.
- Si el test cambia `cwd` o estado global de configuración, restaurarlo en `finally`.
- Colocar tests donde los descubra el script del repo; en este proyecto, la evidencia actual usa `src/**/*.test.ts` con `node:test`.

## Verification
- `node --import tsx/esm --test <test-file>`
- `npm run typecheck`
- `npm test`

```

### docs/wiki/artifact-compatibility.md
Change: create
Rationale: La revisión T5 confirmó explícitamente la compatibilidad de learn con runs Markdown+YAML y la preservación del camino legacy JSON.

```markdown
# Artifact Compatibility

## Learn from Run Artifacts
`learnCommand` debe consumir artifacts `kind: "run"` modernos en Markdown con frontmatter/YAML mediante `parseRun`.

## Legacy Support
El soporte legacy para `runs/*.json` no debe eliminarse sin una migración explícita. La evidencia actual indica que `readRun` conserva parseo JSON cuando el path no termina en `.md`, y el fallback `latestRunFile` aún considera JSON.

## Path Handling
El flujo real puede persistir `SessionArtifact.path` como path absoluto devuelto por `writeArtifact`. Los tests pueden usar paths relativos cuando ejecutan con `cwd` temporal controlado, siempre que validen la resolución real del comando.

## Regression Test Shape
- Crear una sesión activa con un artifact `kind: "run"` que apunte a `docs/log/runs/*.md`.
- No crear `runs/*.json` para ese caso.
- Agregar un distractor más nuevo no referenciado si se necesita probar que el comando usa el artifact de sesión y no el fallback por último archivo.
- Verificar `taskId`, `summary`, `changedFiles`, `verification`, `reviewerNotes` y `humanAnswers` de forma semántica.

```

### docs/wiki/planning-quality.md
Change: append
Rationale: Los runs T3-T5 registran que el plan mencionaba `tests/learn-command.test.ts`, pero el repo no tiene directorio `tests`; el patrón aplicable es validar convenciones reales antes de fijar rutas de tareas.

```markdown

## Validate Repository Conventions Before Fixing Paths
Cuando una tarea propone crear o editar una ruta que no existe, inspeccionar primero la convención real del repo y ajustar la implementación a lo que ejecutan los scripts existentes. En este caso, el plan mencionaba `tests/learn-command.test.ts`, pero la evidencia mostró que los tests viven bajo `src/**/*.test.ts` y son descubiertos por `npm test`.

```

## Pattern Updates
- Para comandos HITL/LLM, usar `ModelProvider` fake, fixture temporal y `cwd` inyectable para evitar red y providers reales.
- Preferir assertions semánticas sobre outputs y mensajes enviados al provider antes que snapshots completos de prompts.
- Probar artifacts persistidos con render/parse/readArtifact para cubrir el flujo real, no solo objetos en memoria.
- Mantener compatibilidad legacy JSON mientras se agregan pruebas para artifacts modernos Markdown+YAML.
- Cuando el plan referencia rutas inexistentes, adaptar la tarea a la convención real del repo y registrar la divergencia.

## Snapshot Updates
- Agregar que los tests del proyecto se ubican actualmente bajo `src/**/*.test.ts`, no en `tests/`.
- Registrar que `learnCommand` persiste learn artifacts salvo el camino `opts.json && !opts.output`.
- Registrar que `SessionArtifact.path` se guarda sin normalizar; el flujo real usa paths absolutos de `writeArtifact`, aunque paths relativos funcionan con `cwd` controlado.
- Agregar como riesgo de pruebas que un provider fake puede ocultar prompts incompletos si no se inspeccionan los `messages` capturados.

## Next Actions
- Crear o actualizar los documentos wiki propuestos con los contenidos pequeños indicados.
- Referenciar estos patrones en futuros planes que prueben comandos con ModelProvider, sesión activa o artifacts persistidos.
- Evitar nuevas tareas que apunten a `tests/` sin confirmar primero que el repo adoptó esa convención.
