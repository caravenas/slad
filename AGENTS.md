# SLAD Agent Notes

## Focus

SLAD is an orchestrator of local coding-agent CLIs (`claude`, `codex`, `pi`, `agy`) — not a general LLM framework.
It drives the loop `explore → snapshot → plan → run → learn → evolve`, and its differentiating feature is parallel plan execution: one agent-CLI worker per task in tmux windows, optionally isolated in per-task git worktrees (`--worktrees`) whose results merge back as staged, uncommitted changes.
There are no HTTP model adapters and no API-key handling: `CliProvider` (in `@slad/model-providers`) spawns the configured agent binary, and `ProviderName` is just `["cli"]`.
Do not reintroduce API providers, key plumbing, or vendor SDKs.

## Architecture

The monorepo is a pnpm + Turborepo workspace with 8 packages:
`shared`, `model-providers`, `tools`, `harness`, `hitl`, `cache`, `pipeline`, `cli`.
Two define the core data contracts:

- `@slad/shared`: canonical Zod schemas and inferred types for agent outputs, sessions, questions, plan tasks, run outputs, learn outputs, evolve outputs, and stage constants.
- `@slad/cli`: Node ESM CLI. Local imports keep `.js` extensions. Internal files may still import from `./core/types.js`; that file bridges to `@slad/shared`.

Removed — do not reference: the `@slad/ui` Next.js dashboard; the `@slad/agent`, `@slad/memory`, `@slad/telemetry`, `@slad/audit-log`, and `@slad/context-budget` micro-packages (folded into `@slad/pipeline` and `@slad/harness`, re-exported from there); the Anthropic/OpenAI/Gemini HTTP adapters; `apps/`; `blueprints/` and the `slad create` command.

Key CLI internals:

- `packages/cli/src/core/backend-registry.ts`: supported agent backends (codex, claude, pi, agy) — binaries, args, prompt modes, model listing. New backends go here; verify a binary's non-interactive flags against the real binary before wiring them.
- `packages/cli/src/commands/run-parallel.ts` + `dag.ts` + `worktrees.ts`: wave scheduler (pairwise-disjoint `PlanTask.files`), worker spawning (tmux window or child process, sentinel files), git worktree lifecycle. Post-task verification is git-based both ways: undeclared files touched (ownership violation) and completed claims with no git changes (phantom-completion) are flagged, or failed under `--strict-ownership`.
- `packages/cli/src/persistence/global-memory.ts`: best-effort bridge to `~/.agents` in both directions — exports learn/evolve results to `~/.agents/{learnings,decisions}` via the global scripts, and `readProjectMemory()` reads `~/.agents/memory/projects/<repo>.md` for injection into parallel handoff prompts (disable both with `SLAD_GLOBAL_MEMORY=off`).
- `packages/cli/src/persistence/manifest.ts`: crash-safe repo-local run manifests under `.slad-os/runs/<runId>/manifest.json`; every auto/run records a trace id, plan binding, lifecycle, tasks, and artifact hashes.
- `slad gate`: validates external JSON with AJV 2020-12 without importing `~/.agents` internals; internal runtime contracts remain Zod schemas from `@slad/shared`.

## Rules

- Add or change cross-package data contracts in `packages/shared/src/schemas.ts`.
- Keep CLI-only runtime callbacks, local discovery, project inventory, and project config schemas in `packages/cli/src/core/types.ts`.
- Typecheck resolves dependency types from source: every package's `exports` maps `types` to `./src/index.ts`. Never reintroduce TypeScript project references or `composite`; `pnpm typecheck` must pass with zero `dist/` present.
- Model ids for CLI backends are backend-specific; with pi, prefer provider-qualified ids (`openai-codex/gpt-5.5`) because bare names fuzzy-match across providers.
- agy models are display names with spaces (`Gemini 3.5 Flash (Low)`), so quote them; agy exits 0 even for unknown model names (silent fallback to its default).
- agy ignores the process cwd: without `--add-dir` it works in its own scratch (`~/.gemini/antigravity-cli/scratch/`) while claiming it wrote to the current directory, and writes need `--dangerously-skip-permissions` in print mode. The registry passes `--add-dir {workspace}`; `{workspace}` is substituted with the absolute workspace path at spawn time (CliProvider and buildWorkerScript).
- Run verification from the root with `corepack pnpm build`, `corepack pnpm typecheck`, and `corepack pnpm test`. CI runs the same three on every push/PR to master.

## Workflow patterns

Use the global Pi + cmux workflow assets for SLAD-inspired workflow patterns. SLAD ideas are useful here as patterns, but this repository should not own the global workflow runtime.

For non-trivial or multi-agent work, prefer the global loop:

`explore → snapshot → plan → run → learn → evolve`

Global assets live outside this repo:

- skill: `~/.agents/skills/slad-workflow/SKILL.md`
- Pi prompt templates: `~/.pi/agent/prompts/{explore,snapshot,plan,handoff,draft-learn,draft-decision}.md`
- memory plan: `~/.agents/memory/pi-cmux-agentic-workflow-plan.md`
- portable scripts: `~/.agents/workflows/scripts/*.mjs`

`slad learn` and `slad evolve` already bridge into that system: when the global scripts exist, their results are also recorded under `~/.agents/learnings/` and `~/.agents/decisions/`.
The bridge also reads back: `slad run --parallel` injects the repo's entry from `~/.agents/memory/projects/` into each worker's handoff prompt when one exists.

Only add project-local workflow memory when a decision or learning is specific to SLAD itself.
