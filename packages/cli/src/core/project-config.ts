import path from "node:path";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { ProjectConfig } from "./types.js";
import { ConfigError } from "./errors.js";

const CONFIG_PATH = ".slad-os/config.json";

export async function loadProjectConfig(projectRoot: string = process.env.SLAD_WORKSPACE ?? process.cwd()): Promise<ProjectConfig> {
  const file = path.join(projectRoot, CONFIG_PATH);
  try {
    const text = await readFile(file, "utf8");
    const json = JSON.parse(text);
    return ProjectConfig.parse(json);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      // No config file → defaults
      return ProjectConfig.parse({});
    }
    if (err instanceof SyntaxError) {
      throw new ConfigError(`invalid JSON in ${CONFIG_PATH}`, { cause: err });
    }
    throw err;
  }
}

export function loadProjectConfigSync(projectRoot: string = process.env.SLAD_WORKSPACE ?? process.cwd()): ProjectConfig {
  const file = path.join(projectRoot, CONFIG_PATH);
  try {
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    return ProjectConfig.parse(json);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return ProjectConfig.parse({});
    }
    if (err instanceof SyntaxError) {
      throw new ConfigError(`invalid JSON in ${CONFIG_PATH}`, { cause: err });
    }
    throw err;
  }
}

export function resolveDocsRoot(config: ProjectConfig, projectRoot: string = process.cwd()): string {
  const envOverride = process.env.SLAD_DOCS_PATH;
  if (envOverride && envOverride.trim() !== "") {
    return path.isAbsolute(envOverride) ? envOverride : path.resolve(projectRoot, envOverride);
  }
  return path.isAbsolute(config.docsPath)
    ? config.docsPath
    : path.resolve(projectRoot, config.docsPath);
}
