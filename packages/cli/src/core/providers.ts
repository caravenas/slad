import { getProvider } from "@slad/model-providers";
import type { ModelProvider } from "@slad/model-providers";
import type { ProviderName as ProviderNameType } from "./types.js";

/**
 * Resolves the ModelProvider for a given provider name.
 * Every provider is a CLI agent binary (codex, claude, …) spawned by
 * CliProvider; the concrete backend is selected via SLAD_CLI_* env vars.
 */
export async function getSladProvider(name: ProviderNameType): Promise<ModelProvider> {
  return getProvider(name);
}
