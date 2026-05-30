export type AppConfig = {
  TIMEOUT_MS: number;
  MAX_RETRIES: number;
};

export function validateConfig(config: AppConfig): true {
  if (config.TIMEOUT_MS <= 0) {
    throw new Error("TIMEOUT_MS must be greater than 0");
  }

  if (config.MAX_RETRIES < 0) {
    throw new Error("MAX_RETRIES must be greater than or equal to 0");
  }

  return true;
}
