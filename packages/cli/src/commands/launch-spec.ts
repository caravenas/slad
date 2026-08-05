import { launchSpecFromEnv } from "@slad/model-providers";

export interface LaunchSpecCommandOptions {
  workspace?: string;
  model?: string;
  timeoutMs?: number;
}

export function launchSpecCommand(options: LaunchSpecCommandOptions): void {
  const spec = launchSpecFromEnv({
    prompt: "{prompt}",
    workspace: options.workspace ?? process.cwd(),
    model: options.model,
    timeoutMs: options.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
}
