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

- **Reviewable execution boundary.** Auto-planning persists one versioned plan artifact under `docs/log/plans/`; run reports are persisted per task. Explore and snapshot are transient planning inputs.
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

# Read-only environment diagnosis: no repairs, no agents, no LLM calls
slad doctor

# Sanity check: one round-trip through the auto-detected backend
slad ask "what does this repo do?"

# Analyze an intent and produce a pending plan (no code changes yet)
slad pipeline auto "add input validation to the signup form" --dry-run

# Review and approve the generated plan
cat docs/log/plans/<session>.json
slad pipeline plan --approve

# Execute the approved plan: independent tasks run in parallel workers
slad pipeline run --parallel
```

## Use cases

### 1. Diagnose the local setup before running agents

```bash
slad doctor
slad doctor --json
```

`slad doctor` is a read-only diagnostic for the local SLAD workspace and runtime prerequisites.
It inspects configuration, repository/runtime state, backend availability, and other checks needed before agent execution, then prints either human-readable output or the shared JSON report.
It never repairs state, writes files, mutates git, invokes agent CLIs, or calls LLM/model APIs.
Use it to decide what a human should fix before `ask`, `auto`, or `run`.

The JSON report has a top-level `status`, a `summary`, and a `checks` array.
Statuses are `healthy` when all checks pass, `warning` when execution can continue but a non-critical issue was found, and `blocked` when at least one required prerequisite is missing or invalid.
The `summary` counts check outcomes as `passed`, `warnings`, and `blockers`; these counts are derived from the `checks` array.
`slad doctor` exits with code `0` for `healthy` and `warning`, and exits non-zero for `blocked` or an internal doctor error.

### 2. Plan first, review, then execute in parallel

```bash
slad pipeline auto "migrate the config module from JSON to TOML" --dry-run
# → writes one pending plan artifact under docs/log/plans/, creates a session

cat docs/log/plans/<session>.json   # review tasks, dependencies, per-task files
slad pipeline plan --approve         # mark the exact plan hash as approved

slad pipeline run --parallel --max-parallel 3
```

Both `plan --approve` and `run` first pass a plan preflight: session binding, approval state, task-DAG integrity, and declared file paths are validated, and any blocker stops the command with a non-zero exit.
`slad pipeline plan --check` runs the same preflight read-only (it does not require or record an approval): it prints the report — or the gate as JSON with `--json` — and exits `0` when the plan is clean, `1` on blockers.
`--bypass` skips only the missing-approval blocker; integrity blockers always stop the run.
Each task's `files` must be literal repo-relative posix paths — globs, backslashes, absolute paths, and `..` segments are preflight blockers, because scheduling and ownership checks compare paths literally.

A plan produced outside SLAD can also be imported as the session's pending plan, with no model call:

```bash
slad pipeline plan --import ./external-plan.json
slad pipeline plan --approve
```

The file must be a strict `slad.external-plan` JSON document — `{ "kind": "slad.external-plan", "schemaVersion": 1, "intent": …, "snapshot": …, "plan": …, "source"?: … }` — whose `intent` matches the active session's intent (whitespace-trimmed).
SLAD rebuilds the envelope on import: planId, revision, digest, approval state, and plan hash are always SLAD-owned, so external envelopes, approvals, or hashes are rejected by the schema.
The document must pass the same plan preflight before anything is persisted; a document that fails schema, intent match, or preflight persists nothing and exits `1`.
Importing over an existing plan supersedes it, exactly like a regenerated plan.

`run --parallel` schedules waves from the task DAG: tasks whose declared `files` don't overlap run concurrently; a task that declares no files runs alone.
Inside tmux, each worker opens in its own window (`slad-T1`, `slad-T2`, …) so you can watch them work; the launching pane shows a live status table.
If a cross-agent memory entry exists for the repo (`~/.agents/memory/projects/<repo>.md`), each worker's handoff prompt includes it — context the worker's own CLI would not load by itself.
Worker prompts, transcripts, and exit codes land under `.slad-os/sessions/<id>/tasks/<taskId>/`.
Every `auto`, `run`, and parallel run also maintains an atomic, schema-validated manifest at `.slad-os/runs/<runId>/manifest.json`, correlated by `traceId`.

### 3. Isolated execution with git worktrees

```bash
slad pipeline run --parallel --worktrees
slad pipeline run --review <runId>
slad pipeline run --apply <runId>
git diff --cached   # review the combined result, then commit yourself
```

Each task runs in its own git worktree branched from a session integration branch (`slad/<sessionId>/…`).
Successful tasks are committed in their worktree and merged sequentially — dependent tasks branch from the updated tip, so they see earlier waves' work.
At the end the result stays on the session integration branch and the run manifest is marked `review_pending`; your main worktree is not touched.
Use `slad pipeline run --review <runId>` to inspect it, `--apply <runId>` to squash it into the main worktree as staged, uncommitted changes, or `--abort <runId>` to discard the integration branch without touching main.
Use `slad pipeline run --parallel --worktrees --from-review <runId>` to run a follow-up plan from the pending integration tip.
Worktree mode requires `--parallel`, a committed HEAD, and a clean main worktree — uncommitted changes abort the run before any worker starts.
`--apply` only proceeds when the main worktree is still clean, its HEAD still matches the recorded base, and the integration branch still matches the recorded tip.
Add `--keep-worktrees` to always keep the session worktrees for inspection.

### 4. Enforce the plan's file ownership

```bash
slad pipeline run --parallel --strict-ownership
```

After each wave (or per task with `--worktrees`), changed files are compared against the plan's declared `files`.
By default violations are warnings recorded in the run report; with `--strict-ownership` the offending task fails and its dependents are skipped — and in worktree mode its changes are not merged at all.
The same git comparison catches the inverse fraud: a task that reports `completed` (or claims `changedFiles`) with zero git changes behind it is flagged as `phantom-completion` — warning by default, task failure under `--strict-ownership`.
Worker-reported results are never trusted without git evidence.

### 5. Choose backend and model per run

```bash
slad pipeline run --parallel --agent claude -m sonnet
slad pipeline run --parallel --agent pi -m openai-codex/gpt-5.5
slad pipeline run --parallel --agent agy -m "Gemini 3.5 Flash (High)"
slad pipeline auto "..." --agent codex
```

With pi, prefer provider-qualified model ids (`openai-codex/gpt-5.5`, `google/gemini-3-flash-preview`) — bare names fuzzy-match across pi's providers.
Persistent defaults live in `~/.slad/config.json` (managed by `slad model`) or per-project in `.slad-os/config.json`.

### 6. Quick answers and conversational mode

```bash
slad ask "why would pnpm hoist this dependency?"
slad chat        # REPL: /explore, /plan, /run T2, /auto ... as slash commands
```

Both spawn the configured backend directly — no pipeline, no session required for `ask`.

### 7. Close the loop: learn and evolve

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
| `slad doctor` | Read-only diagnosis of local SLAD prerequisites; no repairs, agents, or LLM calls |
| `slad gate --schema <path> --input <path>` | Validate external JSON against JSON Schema 2020-12 |
| `slad launch-spec` | Print the canonical backend launch policy as JSON |
| `slad stats` | Session/run/learning totals for the project |
| `slad version` | Print version |

Pipeline runtime (`slad pipeline …`):

| Command | Description |
|---|---|
| `auto <intent>` (alias `work`) | Plans autonomously, then stops for explicit plan approval; resumes the remaining loop after approval |
| `explore <intent>` | Approaches, risks, and next steps for an intent |
| `snapshot` | Mini-spec from the explore output |
| `plan` | Executable task DAG from the snapshot |
| `run [task]` | Execute an approved plan; use `--auto` for the whole DAG, `--parallel` for waves, or `--bypass` to override approval |
| `learn` | Capture decisions/errors/patterns from run reports |
| `evolve` | Propose wiki/prompt updates from recent artifacts |
| `session` | Manage work sessions: `start` creates a new session, `resume` reactivates the active or a given one, plus `list`, `use`, `show` |
| `agents` | List pipeline personas (prompt sets) |

Key flags for `run` / `run --parallel`:

```
--bypass              execute even if the active plan is not approved
--max-parallel <n>    max concurrent workers (default: 3)
--worktrees           per-task git worktrees + sequential merge to a review_pending integration branch
--keep-worktrees      keep session worktrees/branches for debugging
--review <runId>      inspect a review_pending worktree run without changing files
--apply <runId>       squash a review_pending run as staged changes on a clean unchanged main HEAD
--abort <runId>       delete a review_pending run's integration refs without touching main
--from-review <runId> continue from a review_pending integration tip (requires --parallel --worktrees)
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
| `@slad/hitl` | Optional human-input transport for consumers outside the autonomous pipeline stages |
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
corepack pnpm lint
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
