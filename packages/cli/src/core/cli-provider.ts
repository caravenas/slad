import { spawn } from "node:child_process";
import type { ModelProvider } from "@slad/model-providers";
import type { ChatMessage } from "./types.js";

function envStr(key: string): string {
  return process.env[key] ?? "";
}

/** Format a conversation into a single plain-text prompt for CLI agents. */
function formatMessages(messages: ChatMessage[], systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`[System]\n${systemPrompt}`);
  for (const m of messages) {
    const role = m.role === "user" ? "User" : "Assistant";
    parts.push(`[${role}]\n${m.content}`);
  }
  return parts.join("\n\n");
}

/** Spawn a subprocess and return its full stdout as a string. */
function runCli(binary: string, args: string[], stdinData?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    if (stdinData !== undefined) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${binary} exited with code ${code}:\n${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });
  });
}

/**
 * ModelProvider that delegates to a local CLI binary (codex, claude, gemini…).
 * Reads SLAD_CLI_BINARY, SLAD_CLI_ARGS, SLAD_CLI_PROMPT_MODE, CLI_MODEL from env.
 */
export class CliProvider implements ModelProvider {
  readonly name = "cli" as const;
  readonly supportsToolUse = false;

  private readonly binary: string;
  private readonly extraArgs: string[];
  private readonly promptMode: "stdin" | "arg" | "";
  private readonly model: string;

  constructor() {
    this.binary = envStr("SLAD_CLI_BINARY") || "codex";
    this.extraArgs = envStr("SLAD_CLI_ARGS")
      .split(/\s+/)
      .filter(Boolean);
    this.promptMode = (envStr("SLAD_CLI_PROMPT_MODE") || "stdin") as "stdin" | "arg" | "";
    this.model = envStr("CLI_MODEL");
  }

  async complete(messages: ChatMessage[], opts?: { systemPrompt?: string; model?: string }): Promise<string> {
    const prompt = formatMessages(messages, opts?.systemPrompt);
    const model = opts?.model ?? this.model;

    const modelArgs: string[] = [];
    if (model && envStr("SLAD_CLI_MODEL_ARG")) {
      modelArgs.push(envStr("SLAD_CLI_MODEL_ARG"), model);
    }

    switch (this.promptMode) {
      case "stdin": {
        const args = [...this.extraArgs, ...modelArgs];
        return runCli(this.binary, args, prompt);
      }
      case "arg": {
        const args = [...this.extraArgs, ...modelArgs, prompt];
        return runCli(this.binary, args);
      }
      default: {
        // Fallback: pass prompt as last argument
        const args = [...this.extraArgs, ...modelArgs, prompt];
        return runCli(this.binary, args);
      }
    }
  }
}
