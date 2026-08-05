# Plan: Refocus SLAD as an orchestrator of agent CLIs

Date: 2026-07-02.
Status: Everything shipped 2026-07-03 (commits b0e2141..b97ef69): phases 0-4, slad create removed, classifier revived, vestigial env removed, and v2 per-task worktrees (--worktrees). Nothing open.

## Goal

Strip SLAD down from "general agent framework" to "orchestrator of existing agent CLIs (claude, codex, pi) for the explore → snapshot → plan → run → learn → evolve loop", with parallel task execution in tmux as the differentiating feature.

## Non-goals

- Competing with the Claude Agent SDK, Vercel AI SDK, or LangGraph as a general framework.
- Maintaining hand-rolled HTTP provider adapters.
- Building dashboards or docs sites inside this repo.

## Existing assets the plan builds on

- `packages/cli/src/core/backend-registry.ts` already models `codex` and `claude` as subprocess backends.
- `packages/cli/src/core/cli-provider.ts` already implements `ModelProvider` over a spawned CLI binary.
- `packages/cli/src/commands/dag.ts` already implements `getParallelRunnableTasks()` and `autoSkipDependents()` — the wave scheduler exists.
- `PlanTask.files` (packages/shared/src/schemas.ts:187) already carries per-task file ownership.

---

## Phase 0 — Stop the bleeding (hygiene, no behavior change)

### 0.1 Fix `pnpm typecheck` (TS6305)

`@slad/pipeline` typecheck fails today: TS6305 stale-`dist` errors against harness/hitl/tools, because Turbo restores cached `dist/` while tsc's incremental state disagrees.
Investigate and fix so `corepack pnpm typecheck` passes from a clean clone and from a warm Turbo cache.
Likely fixes to evaluate: include `*.tsbuildinfo` in Turbo `build` outputs, or switch `typecheck` to `tsc -b --noEmit`-compatible project references, or have `typecheck` not rely on emitted `.d.ts` at all (`paths` to source).
Acceptance: `rm -rf node_modules/.cache .turbo packages/*/dist && corepack pnpm install && corepack pnpm build && corepack pnpm typecheck` passes twice in a row.

### 0.2 Add CI

Add `.github/workflows/ci.yml`: Node 22, corepack pnpm install, build, typecheck, test, on push and PR to master.
Acceptance: CI green on a no-op PR.

### 0.3 Fix documentation drift

README: remove the `@slad/ui` row, update the package table to match reality after Phase 1 lands (do the final pass at the end of Phase 1).
CLAUDE.md: list all current packages, not just shared and cli.
Acceptance: every package named in README/CLAUDE.md exists, and every package that exists is named.

---

## Phase 1 — Cut the fat (removals and consolidation)

Order matters: each step keeps build/typecheck/test green.

### 1.1 Delete stub apps

Delete `apps/dashboard` and `apps/docs` (~50–70 LOC console demos each, no consumers).
Remove them from the workspace and any turbo filters.

### 1.2 Finish the harness migration

`packages/cli/src/harness/` (approval, classifier, config) duplicates `packages/harness/`, and `auto.ts` / `run.ts` import from both.
Diff the two implementations; port any CLI-only deltas into `@slad/harness` first, then delete `packages/cli/src/harness/` and point all CLI imports at `@slad/harness`.
Acceptance: `grep -r "from \"../harness" packages/cli/src` returns nothing; all tests pass.

### 1.3 Collapse the micro-packages

Fold `@slad/agent` (110 LOC), `@slad/memory` (180), `@slad/telemetry` (125), `@slad/audit-log` (174) into `@slad/pipeline`.
They are pure interfaces plus one or two tiny implementations each; the packaging ceremony outweighs the content.
Keep the same exported names; re-export from `@slad/pipeline` so call sites change only their import specifier.
Update `examples/research-agent` and `packages/cli/demo` imports.
Decision point (small): fold `@slad/context-budget` too, since only pipeline consumes it — recommended yes, same PR or a follow-up.
Acceptance: workspace has at most 8 packages; build/typecheck/test green.

### 1.4 Remove the HTTP provider adapters

Precondition: verify `generateObject()` (schema-validated JSON with auto-fix retry) works end-to-end over the CLI provider with `claude -p` and `codex`, since the reasoning stages depend on it.
Run `slad explore` and `slad plan` with `--provider cli` against a scratch repo as the check.
Then delete `anthropic.ts`, `openai.ts`, `gemini.ts` from `@slad/model-providers`, keeping the `ModelProvider` interface, `ModelAdapter`, retry/timeout, and the CLI provider path.
Remove API-key handling from `.env.example`, `core/config.ts` (`DEFAULT_MODELS`, provider switch), and README.
Fallback if the precondition fails: fix the CLI provider's structured-output path first (e.g. `claude -p --output-format json`); do not keep the HTTP adapters as a workaround.
Acceptance: `grep -rn "api.anthropic.com\|api.openai.com\|generativelanguage" packages` returns nothing; `slad auto --dry-run` works with the CLI backend.

### 1.5 Trim blueprints

Keep `blueprints/agents/basic-agent` plus the single-item stage/tool/pipeline templates that `slad create` scaffolds.
Delete `blueprints/agents/enterprise` unless it is exercised by tests.
Decision point: if `slad create` itself has no real use after the refocus, delete the command and all blueprints in a follow-up — flagging, not deciding here.

---

## Phase 2 — First-class CLI backends

### 2.1 Add `pi` as a backend

Extend `CliBackendId` to `["codex", "claude", "pi"]` in `backend-registry.ts`.
First task: discover pi's non-interactive invocation (print mode, output format, exit codes) — this is unknown and must be verified against the installed binary at `~/.nvm/versions/node/v22.22.2/bin/pi`, not assumed.
Add a registry entry with the right flags, plus a smoke test that shells out to `pi --version` (skipped when the binary is absent, same pattern as any existing backend tests).

### 2.2 Make `cli` the default provider

Change the default `--provider` from `anthropic` to `cli` with backend auto-detection (prefer whichever of claude/pi/codex is on PATH, configurable in `slad.config`).
Acceptance: `slad auto "<intent>"` with zero env vars and zero flags works on this machine.

---

## Phase 3 — The differentiating feature: parallel run in tmux

This is the reason to keep the project alive; everything before it is enabling work.

### 3.1 Wave scheduler with file-ownership safety

Build on `getParallelRunnableTasks()`: only co-schedule tasks within a wave whose `PlanTask.files` sets are pairwise disjoint; tasks with overlapping files run in later waves even when the DAG would allow them.
Tasks with empty `files` are conservatively treated as owning everything (never co-scheduled) until the plan stage reliably fills the field.
Unit-test the scheduler exhaustively — it is pure logic.

### 3.2 tmux worker execution

`slad run --parallel [--max-workers N]`:
- For each runnable task, render a handoff prompt (task description, acceptance criteria, owned files, "do not touch files outside your ownership list") from the plan artifact.
- Spawn one tmux pane/window per task via `tmux new-window -t <session>` running the backend CLI in print mode; fall back to plain child processes when not inside tmux (`$TMUX` unset).
- Detect completion via wrapper script writing exit status to a sentinel file under `.slad-os/sessions/<id>/tasks/<taskId>/`; the orchestrator polls sentinels, marks tasks done/failed, applies `autoSkipDependents()`, and launches the next wave.

### 3.3 Post-task ownership check

After each task completes, run `git diff --name-only` against the pre-task ref and warn (or fail the task, behind `--strict-ownership`) when it touched files outside its `files` set.
This is verification, not sandboxing — honest about what it is.

### 3.4 Control-pane UX

One tmux pane running the orchestrator shows a live DAG status table (task, state, wave, backend, elapsed), reusing the existing `stats`/format helpers.
Keep it plain text; no TUI framework.

### 3.5 Deferred (v2, record as decision)

Per-task git worktrees with sequential merge — stronger isolation, real complexity.
Not in this plan; revisit after 3.1–3.4 have been used on a real task.

---

## Phase 4 — Converge decision/learning capture with global memory

Today `packages/cli/src/persistence/decisions.ts` writes `docs/log/decisions/<session>.json`, while the global workflow owns `~/.agents/workflows/scripts/record-decision.mjs` and `record-learning.mjs` — two owners of the same concept.
Resolution: repo-local `docs/log/` stays the canonical per-project record; after `learn`/`evolve`, SLAD additionally invokes the global scripts (when present) so `~/.agents/memory` stays the single global aggregation point.
Guard the invocation behind existence checks; SLAD must keep working on machines without the global assets.
Acceptance: running `slad learn` on this repo produces both the session JSON and a global memory entry.

---

## Sequencing and effort

Phases 0 and 1 are enabling work and should land as a series of small PRs (0.1, 0.2, 1.1+1.5, 1.2, 1.3, 1.4 — roughly six).
Phase 2 is small (one PR).
Phase 3 is the substantial build (3.1 scheduler PR, then 3.2–3.4 as one or two PRs).
Phase 4 is one small PR.
Stop-loss: if after Phase 2 the appetite for Phase 3 is gone, the repo is still net healthier — but the honest move at that point is Option B (freeze), not slow-rolling Phase 3.

## Decision points for Chris

1. Fold `@slad/context-budget` into pipeline along with the other micro-packages? (Recommended: yes.)
2. Keep or kill `slad create` + blueprints after the refocus? (Deferred to end of Phase 1.)
3. `--strict-ownership` failing tasks vs warning only as the default in 3.3? (Recommended: warn by default.)
