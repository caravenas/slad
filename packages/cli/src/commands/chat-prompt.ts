import kleur from "kleur";

/**
 * Pure rendering helpers for the boxed REPL input (Claude Code / Codex style).
 *
 * The interactive keypress loop lives in chat.ts; everything here is pure and
 * unit-tested: given the prompt state it returns the exact lines to draw and
 * where the cursor should sit. No I/O, no ANSI cursor moves.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/** Visible (printable) width of a string, ignoring ANSI color codes. */
export function visibleWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

/** A single entry in the inline slash-command dropdown. */
export interface PromptSlashItem {
  /** Text inserted when the item is completed, e.g. "/explore " or "/help". */
  insertion: string;
  /** Display signature, e.g. "/explore <intent>". */
  signature: string;
  description: string;
  /** Whether the command takes arguments (→ complete, don't submit, on Enter). */
  hasArgs: boolean;
}

export interface PromptFrameState {
  value: string;
  /** Prompt indicator (may contain ANSI), e.g. cyan "❯". */
  promptPrefix: string;
  /** Terminal columns. */
  width: number;
  /** Inline dropdown items (empty = no dropdown). */
  suggestions: PromptSlashItem[];
  /** Highlighted dropdown index. */
  selected: number;
}

export interface PromptFrame {
  /** Lines to draw, top to bottom. */
  lines: string[];
  /** Index (into `lines`) of the editable input line. */
  inputLineIndex: number;
  /** 0-based column where the cursor should sit on the input line. */
  cursorCol: number;
}

const MIN_WIDTH = 24;
const MAX_SIG_WIDTH = 28;
/** Max dropdown rows shown at once; the list scrolls past this as you navigate. */
const MAX_VISIBLE_SUGGESTIONS = 8;

/** Use the full terminal width (no upper cap) so the rules span the whole line. */
function clampWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 80;
  return Math.max(MIN_WIDTH, Math.floor(width));
}

/**
 * Build the multi-line frame for the prompt:
 *
 *   ─────────────────────────────   (top rule)
 *    ❯ <value>                       (input line)
 *   ─────────────────────────────   (bottom rule)
 *    ❯ /explore  Explora una intención…  (dropdown, when slash active)
 *      /help    Show help…
 *      ↑↓ navegar · Tab completar · Enter ejecutar · Esc cerrar
 */
export function buildPromptFrame(state: PromptFrameState): PromptFrame {
  const width = clampWidth(state.width);
  const rule = kleur.dim("─".repeat(width));

  const inputLine = ` ${state.promptPrefix} ${state.value}`;
  const cursorCol = 1 + visibleWidth(state.promptPrefix) + 1 + state.value.length;

  const lines: string[] = [rule, inputLine, rule];
  const inputLineIndex = 1;

  const total = state.suggestions.length;
  if (total > 0) {
    // Scrolling window: keep the selected item in view, revealing the rest as
    // you navigate instead of capping at the first N commands.
    const offset =
      total > MAX_VISIBLE_SUGGESTIONS
        ? Math.min(
            Math.max(0, state.selected - Math.floor(MAX_VISIBLE_SUGGESTIONS / 2)),
            total - MAX_VISIBLE_SUGGESTIONS,
          )
        : 0;
    const visible = state.suggestions.slice(offset, offset + MAX_VISIBLE_SUGGESTIONS);
    const sigWidth = Math.min(
      MAX_SIG_WIDTH,
      Math.max(...visible.map((item) => visibleWidth(item.signature))),
    );
    visible.forEach((item, index) => {
      const absolute = offset + index;
      const isSelected = absolute === state.selected;
      const marker = isSelected ? kleur.cyan("❯") : " ";
      const sig = isSelected ? kleur.cyan(item.signature) : kleur.white(item.signature);
      const pad = " ".repeat(Math.max(0, sigWidth - visibleWidth(item.signature)));
      lines.push(` ${marker} ${sig}${pad}  ${kleur.dim(item.description)}`);
    });

    const above = offset;
    const below = total - (offset + visible.length);
    const scroll = [above > 0 ? `↑ ${above}` : "", below > 0 ? `↓ ${below}` : ""]
      .filter(Boolean)
      .join(" ");
    const hint = `↑↓ navegar · Tab completar · Enter ejecutar · Esc cerrar${scroll ? `  ·  ${scroll}` : ""}`;
    lines.push(kleur.dim(`   ${hint}`));
  }

  return { lines, inputLineIndex, cursorCol };
}

/** Clamp/normalize a selection index against the available suggestions. */
export function clampSelection(selected: number, count: number): number {
  if (count <= 0) return 0;
  if (selected < 0) return count - 1;
  if (selected >= count) return 0;
  return selected;
}

/**
 * Render a submitted input line as a single attenuated trace, e.g. `› /model`.
 *
 * Uses gray (SGR 90) rather than faint (SGR 2): many terminals don't render
 * "dim", but gray is universally muted and matches the desired look.
 */
export function renderSubmittedLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return kleur.gray(`› ${trimmed}`);
}
