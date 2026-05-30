import { getProvider } from "@slad/model-providers";
import type { ModelProvider } from "@slad/model-providers";
import type { ProviderName as ProviderNameType } from "./types.js";
import { CliProvider } from "./cli-provider.js";

/**
 * Resolves the ModelProvider for a given provider name.
 * Handles "cli" locally (spawning the configured CLI binary) and delegates
 * all API providers to @slad/model-providers.
 */
export async function getSladProvider(name: ProviderNameType, apiKey?: string): Promise<ModelProvider> {
  if (name === "cli") {
    return new CliProvider();
  }
  return getProvider(name, apiKey);
}
