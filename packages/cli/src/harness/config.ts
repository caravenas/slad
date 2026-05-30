import fs from "node:fs";
import path from "node:path";
import { HarnessConfig, type HarnessMode } from "@slad/harness";

const CONFIG_PATH = ".slad-os/harness.json";

export function loadHarnessConfig(
  modeOverride: HarnessMode,
  cwd = process.env.SLAD_WORKSPACE ?? process.cwd(),
): HarnessConfig {
  const configPath = path.join(cwd, CONFIG_PATH);
  let fileConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      // Invalid config — use defaults.
    }
  }

  return HarnessConfig.parse({
    ...fileConfig,
    mode: modeOverride,
  });
}
