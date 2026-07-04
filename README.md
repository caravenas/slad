# SLAD

**S**elf-**L**earning **A**utonomous **D**eveloper — an orchestrator for local coding-agent CLIs.

SLAD does not call model APIs and needs no API keys.
It drives the agent CLIs you already have installed — `claude`, `codex`, `pi`, `agy` — through a structured engineering loop:

```
explore → snapshot → plan → run → learn → evolve
```

Its flagship feature is parallel plan execution: one agent worker per task, each in its own tmux window, optionally isolated in per-task git worktrees whose results merge back into your working tree as staged, uncommitted changes.

## Why SLAD

Agent CLIs are excellent at single tasks but unstructured for larger work.
SLAD adds what a solo agent session lacks:

- **Explicit stages with reviewable artifacts.** Every stage writes JSON to `docs/log/` (explore analysis, snapshot spec, task plan, per-task run reports), tied together by a session.
- **Safe parallelism.** The plan is a task DAG with per-task file ownership; SLAD schedules waves of tasks whose files don't overlap and runs one worker per task.
- **Real isolation when you want it.** With `--worktrees`, workers physically cannot touch each other's files, and you get per-task change attribution.
- **A memory loop.** `learn` extracts decisions/errors/patterns from run reports; `evolve` proposes prompt/wiki updates; both can feed a global cross-project memory — and parallel workers read the project's global memory entry back in their handoff prompts.

## Requirements

- Node 22+ and Corepack-enabled pnpm.
- git (required for ownership checks and `--worktrees`).
- At least one agent CLI on your PATH: `claude`, `codex`, `pi`, or `agy`.
- tmux (optional — workers get their own windows when you run inside tmux; plain child processes otherwise).

## Install

```bash
corepack pnpm install
corepack pnpm build
cd packages/cli && npm link   # exposes the `slad` binary globally
```

Zero configuration is needed to start: SLAD auto-detects the first available backend (`claude` → `pi` → `codex` → `agy`).
To pick defaults explicitly, run `slad model`, or pass `--agent` / `-m` per run.

## Quick start

```bash
cd your-project

# Sanity check: one round-trip through the auto-detected backend
slad ask "what does this repo do?"

# Analyze an intent and produce a plan (no code changes yet)
slad pipeline auto "add input validation to the signup form" --dry-run

# Execute the plan: independent tasks run in parallel workers
slad pipeline run --parallel
```

## Use cases

### 1. Plan first, review, then execute in parallel

```bash
slad pipeline auto "migrate the config module from JSON to TOML" --dry-run
# → writes explore/snapshot/plan artifacts under docs/log/, creates a session

cat docs/log/plans/<session>.json   # review tasks, dependencies, per-task files

slad pipeline run --parallel --max-parallel 3
```

`run --parallel` schedules waves from the task DAG: tasks whose declared `files` don't overlap run concurrently; a task that declares no files runs alone.
Inside tmux, each worker opens in its own window (`slad-T1`, `slad-T2`, …) so you can watch them work; the launching pane shows a live status table.
If a cross-agent memory entry exists for the repo (`~/.agents/memory/projects/<repo>.md`), each worker's handoff prompt includes it — context the worker's own CLI would not load by itself.
Worker prompts, transcripts, and exit codes land under `.slad-os/sessions/<id>/tasks/<taskId>/`.

### 2. Isolated execution with git worktrees

```bash
slad pipeline run --parallel --worktrees
git diff --cached   # review the combined result, then commit yourself
```

Each task runs in its own git worktree branched from a session integration branch (`slad/<sessionId>/…`).
Successful tasks are committed in their worktree and merged sequentially — dependent tasks branch from the updated tip, so they see earlier waves' work.
At the end the result is squashed into your main worktree as staged, uncommitted changes; your branch gets no commits.
Requires a committed HEAD; add `--keep-worktrees` to inspect the session worktrees afterwards.

### 3. Enforce the plan's file ownership

```bash
slad pipeline run --parallel --strict-ownership
```

After each wave (or per task with `--worktrees`), changed files are compared against the plan's declared `files`.
By default violations are warnings recorded in the run report; with `--strict-ownership` the offending task fails and its dependents are skipped — and in worktree mode its changes are not merged at all.

### 4. Choose backend and model per run

```bash
slad pipeline run --parallel --agent claude -m sonnet
slad pipeline run --parallel --agent pi -m openai-codex/gpt-5.5
slad pipeline run --parallel --agent agy -m "Gemini 3.5 Flash (High)"
slad pipeline auto "..." --agent codex
```

With pi, prefer provider-qualified model ids (`openai-codex/gpt-5.5`, `google/gemini-3-flash-preview`) — bare names fuzzy-match across pi's providers.
Persistent defaults live in `~/.slad/config.json` (managed by `slad model`) or per-project in `.slad-os/config.json`.

### 5. Quick answers and conversational mode

```bash
slad ask "why would pnpm hoist this dependency?"
slad chat        # REPL: /explore, /plan, /run T2, /auto ... as slash commands
```

Both spawn the configured backend directly — no pipeline, no session required for `ask`.

### 6. Close the loop: learn and evolve

```bash
slad pipeline learn    # extract decisions, errors, and patterns from the session's run reports
slad pipeline evolve   # propose wiki/prompt updates from recent artifacts
```

Learnings and decisions are written to `docs/log/` (the canonical per-project record).
If the global workflow scripts exist (`~/.agents/workflows/scripts/record-{learning,decision}.mjs`), results are also exported to `~/.agents/learnings/` and `~/.agents/decisions/`, so cross-project memory aggregates in one place.
This bridge is best-effort and can be disabled with `SLAD_GLOBAL_MEMORY=off`.

## CLI reference

Top level:

| Command | Description |
|---|---|
| `slad ask <question>` | Direct answer from the backend, no pipeline |
| `slad chat` | Conversational REPL with slash commands |
| `slad model` | Configure default backend, binary, and model |
| `slad stats` | Session/run/learning totals for the project |
| `slad version` | Print version |

Pipeline runtime (`slad pipeline …`):

| Command | Description |
|---|---|
| `auto <intent>` (alias `work`) | Full loop: explore → snapshot → plan → run → learn |
| `explore <intent>` | Approaches, risks, and next steps for an intent |
| `snapshot` | Mini-spec from the explore output |
| `plan` | Executable task DAG from the snapshot |
| `run [task]` | Execute one task, `--auto` for the whole DAG, `--parallel` for waves |
| `learn` | Capture decisions/errors/patterns from run reports |
| `evolve` | Propose wiki/prompt updates from recent artifacts |
| `session` | Manage work sessions (start, list, use, show) |
| `agents` | List pipeline personas (prompt sets) |

Key flags for `run --parallel`:

```
--max-parallel <n>    max concurrent workers (default: 3)
--worktrees           per-task git worktrees + sequential merge + final squash
--keep-worktrees      keep session worktrees/branches for debugging
--strict-ownership    fail tasks that touch undeclared files
--agent <name>        backend: claude | codex | pi | agy
-m, --model <id>      model passed to the backend
```

Useful environment variables:

```bash
SLAD_CLI_BINARY=claude        # backend binary (auto-detected when unset)
SLAD_CLI_ARGS=--print         # non-interactive flags for the binary
SLAD_CLI_PROMPT_MODE=arg      # arg | stdin
CLI_MODEL=sonnet              # model forwarded to the backend
SLAD_GLOBAL_MEMORY=off        # disable the ~/.agents memory bridge
SLAD_LOG_LEVEL=info
```

## Repository structure

This is a pnpm + Turborepo monorepo.

| Package | Purpose |
|---|---|
| `@slad/shared` | Zod schemas, granular `Permission` type, serializable contracts |
| `@slad/model-providers` | `ModelProvider` seam + `CliProvider` (spawns agent CLIs) + `ModelAdapter` (`generateObject` / `generateText` with auto-fix JSON) |
| `@slad/tools` | `defineTool()`, `ToolRegistry`, 9 builtin tools (`fs.readFile`, `shell.exec`, …) |
| `@slad/harness` | Execution harness: command classification, hooks, LDJSON audit log, `assertPermission()` |
| `@slad/hitl` | Human-in-the-loop transports (TTY, none) |
| `@slad/cache` | Stage output cache (`CacheStore`) |
| `@slad/pipeline` | `defineStage`, `runPipeline`, `buildSladPipeline`, the 5 SLAD stages, `createAgent()`, memory/telemetry providers, budget tracking |
| `@slad/cli` | The `slad` orchestrator CLI |

## Embedding SLAD (SDK)

The CLI is one consumer; the pipeline runtime is a library.

```ts
import { buildSladPipeline, createAgent } from "@slad/pipeline";
import { getProvider } from "@slad/model-providers";
import { createHarness } from "@slad/harness";

const provider = await getProvider("cli"); // spawns the agent binary from SLAD_CLI_* env
const harness  = await createHarness({ mode: "on", maxPermission: "workspace" });

const agent = createAgent({
  model: provider,
  safety: harness,
  pipeline: buildSladPipeline({ stages: ["explore", "snapshot", "plan", "run", "learn"] }),
});

const result = await agent.run({ intent: "add a sum() to packages/math" });
```

Custom stages (`defineStage`), tools (`defineTool` + `ToolRegistry`), memory (`WikiMemoryProvider`), and telemetry (`LDJSONTelemetry`) compose the same way — everything is exported from `@slad/pipeline` and `@slad/tools`.
Inside a stage, `ctx.model.generateObject({ schema, system, input })` gives schema-validated JSON from the backend with auto-fix retries.

## Development

```bash
corepack pnpm install
corepack pnpm typecheck   # no build needed: types resolve from source
corepack pnpm build
corepack pnpm test
corepack pnpm --filter @slad/cli test
```

- Local ESM imports use `.js` extensions in source.
- Shared serializable contracts live in `packages/shared/src` — don't duplicate them.
- Every package's `exports` maps `types` to `./src/index.ts`; no TypeScript project references.
- Tests use `node --test` with the `tsx/esm` loader. Run a single file from inside a package: `node --import tsx/esm --test src/foo.test.ts`.
- CI (GitHub Actions) runs typecheck, build, and test on every push and PR to master.

## License

Private.
