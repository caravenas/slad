/**
 * Controlled-signal interruption for long-running commands.
 *
 * Two classes of death, with different promises:
 *
 * - **Class A — caught signal** (`SIGINT`/`SIGTERM`): the first signal aborts
 *   the scope and notifies listeners; it never calls `process.exit`. The
 *   command unwinds on its own so every durable write in flight completes,
 *   which is what makes the manifest exact and the run natively resumable.
 * - **Class B — uncaught death** (`SIGKILL`, crash, a second `Ctrl-C`): the
 *   second signal exits hard with 130. Insisting with the signal is the user
 *   asking for exactly that, and the run degrades to "diagnosed, not resumable".
 */

/**
 * Reference to the real process.exit captured at module load, so a test or a
 * command that stubs process.exit cannot swallow the hard second-signal exit.
 */
const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);

/** Exit code for a run terminated by a caught interrupt signal. */
export const INTERRUPT_EXIT_CODE = 130;

export type InterruptSignal = "SIGINT" | "SIGTERM";

export interface InterruptScope {
  /** Passed down to workers and abort-aware waits. */
  readonly signal: AbortSignal;
  /** True once a first signal was observed. */
  interrupted(): boolean;
  /** Which signal terminated the scope, or null while still running. */
  interruptedBy(): InterruptSignal | null;
  /** Runs on the first signal only. Listener errors are swallowed. */
  onInterrupt(listener: (signal: InterruptSignal) => void): void;
  /** Unregisters the process handlers; safe to call twice. */
  dispose(): void;
}

export interface CreateInterruptScopeOptions {
  /** Test seam: replaces the real hard exit on the second signal. */
  hardExit?: (code: number) => void;
  /** Test seam: replaces `process.on` / `process.off` registration. */
  target?: Pick<NodeJS.Process, "on" | "off">;
}

const SIGNALS: InterruptSignal[] = ["SIGINT", "SIGTERM"];

export function createInterruptScope(options: CreateInterruptScopeOptions = {}): InterruptScope {
  const hardExit = options.hardExit ?? ((code: number) => { ORIGINAL_PROCESS_EXIT(code); });
  const target = options.target ?? process;
  const controller = new AbortController();
  const listeners: ((signal: InterruptSignal) => void)[] = [];
  let received: InterruptSignal | null = null;
  let disposed = false;

  const handlers = new Map<InterruptSignal, () => void>();
  for (const name of SIGNALS) {
    const handler = () => {
      if (received !== null) {
        // Second signal: the user insists. Exit hard and let the run be
        // diagnosed as class B rather than pretending the state is exact.
        hardExit(INTERRUPT_EXIT_CODE);
        return;
      }
      received = name;
      controller.abort();
      for (const listener of listeners) {
        try {
          listener(name);
        } catch {
          // An interrupt listener must never prevent the unwind.
        }
      }
    };
    handlers.set(name, handler);
    target.on(name, handler);
  }

  return {
    signal: controller.signal,
    interrupted: () => received !== null,
    interruptedBy: () => received,
    onInterrupt(listener) {
      listeners.push(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [name, handler] of handlers) target.off(name, handler);
    },
  };
}
