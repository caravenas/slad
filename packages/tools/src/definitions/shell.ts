import type { Shell } from "../types.js";
import { execDef, execExec } from "../shell.js";

export { execDef, execExec };

export function createShellExecutors(shell: Shell) {
  return {
    execExec: (args: { command: string; timeout?: number }, cwd: string) => execExec(args, cwd, shell),
  };
}
