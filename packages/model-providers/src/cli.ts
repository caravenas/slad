import { spawn } from "node:child_process";
import type { ModelProvider } from "./index.js";
import { LaunchSpec, type LaunchSpec as LaunchSpecValue } from "@slad/shared";
import type { ChatMessage, CompletionOptions } from "./types.js";

function envStr(key: string): string {
  return process.env[key] ?? "";
}

/** Format a conversation into a single plain-text prompt for CLI agents. */
function formatMessages(messages: ChatMessage[], systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`[System]\n${systemPrompt}`);
  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    parts.push(`[${role}]\n${message.content}`);
  }
  return parts.join("\n\n");
}

export interface RunCliOptions {
  stdinData?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  killGraceMs?: number;
}

/** Spawn a subprocess, enforcing abort/timeout on its complete process group. */
export function runCli(binary: string, args: string[], options: RunCliOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${binary} cancelled before spawn`));
      return;
    }

    const detached = process.platform !== "win32";
    const proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
      detached,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminalReason: "timeout" | "cancelled" | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (proc.pid === undefined || proc.exitCode !== null) return;
      try {
        if (detached) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch {
        // The process may have exited between the state check and the signal.
      }
    };

    const terminate = (reason: "timeout" | "cancelled"): void => {
      if (terminalReason || proc.exitCode !== null) return;
      terminalReason = reason;
      signalProcessGroup("SIGTERM");
      forceKillTimer = setTimeout(() => signalProcessGroup("SIGKILL"), options.killGraceMs ?? 2_000);
      forceKillTimer.unref();
    };

    const timeout = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => terminate("timeout"), options.timeoutMs)
      : undefined;
    timeout?.unref();
    const onAbort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    if (options.stdinData !== undefined) proc.stdin.write(options.stdinData);
    proc.stdin.end();

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalReason) {
        reject(new Error(`${binary} ${terminalReason}${signal ? ` (${signal})` : ""}`));
      } else if (code !== 0) {
        reject(new Error(`${binary} exited with code ${code}:\n${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to spawn ${binary}: ${error.message}`));
    });
  });
}

export interface LaunchSpecOptions {
  prompt: string;
  workspace?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  permissionProfile?: LaunchSpecValue["permissionProfile"];
}

/** Canonical launch construction shared by generation and parallel workers. */
export function launchSpecFromEnv(options: LaunchSpecOptions): LaunchSpecValue {
  const workspace = options.workspace ?? process.cwd();
  const binary = envStr("SLAD_CLI_BINARY") || "codex";
  const baseArgs = envStr("SLAD_CLI_ARGS")
    .split(/\s+/)
    .filter(Boolean)
    .map((arg) => arg === "{workspace}" ? workspace : arg);
  const promptMode = (envStr("SLAD_CLI_PROMPT_MODE") || "stdin") === "arg" ? "arg" : "stdin";
  const model = (options.model ?? envStr("CLI_MODEL")) || undefined;
  const modelArg = envStr("SLAD_CLI_MODEL_ARG");
  const modelArgs = model && modelArg ? [modelArg, model] : [];
  const args = promptMode === "stdin"
    ? [...baseArgs, ...modelArgs]
    : [...modelArgs, ...baseArgs, options.prompt];
  return LaunchSpec.parse({
    binary,
    args,
    env: {},
    cwd: workspace,
    promptMode,
    ...(promptMode === "stdin" ? { stdin: options.prompt } : {}),
    permissionProfile: options.permissionProfile ?? "workspace-write",
    model,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    signalPolicy: options.signal ? "abort-signal" : "none",
  });
}

/** ModelProvider that delegates to a configured local coding-agent CLI. */
export class CliProvider implements ModelProvider {
  readonly name = "cli" as const;
  readonly supportsToolUse = false;

  private readonly model: string;
  private readonly timeoutMs: number;

  constructor() {
    this.model = envStr("CLI_MODEL");
    const configuredTimeout = Number.parseInt(envStr("SLAD_CLI_TIMEOUT_MS"), 10);
    this.timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15 * 60_000;
  }

  async complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string> {
    const prompt = formatMessages(messages, opts?.systemPrompt);
    const spec = launchSpecFromEnv({
      prompt,
      model: opts?.model ?? this.model,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      signal: opts?.signal,
    });
    return runCli(spec.binary, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdinData: spec.stdin,
      timeoutMs: spec.timeoutMs,
      signal: opts?.signal,
    });
  }
}
