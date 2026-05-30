import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = ".slad-os/config.json";
const LEGACY_CLI_DOCS_PATH = "packages/cli/docs";

function defaultDocsRoot(projectRoot: string): string {
  const legacyCliDocs = path.resolve(projectRoot, LEGACY_CLI_DOCS_PATH);
  return fs.existsSync(legacyCliDocs) ? legacyCliDocs : path.resolve(projectRoot, "docs");
}

function resolveDocsPath(projectRoot: string, docsPath: string): string {
  const resolved = path.isAbsolute(docsPath) ? docsPath : path.resolve(projectRoot, docsPath);
  if (
    docsPath === "docs" &&
    !fs.existsSync(path.join(resolved, "log", "sessions")) &&
    fs.existsSync(path.join(projectRoot, LEGACY_CLI_DOCS_PATH, "log", "sessions"))
  ) {
    return path.resolve(projectRoot, LEGACY_CLI_DOCS_PATH);
  }
  return resolved;
}

export function resolveUiProjectRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === "ui" && path.basename(path.dirname(cwd)) === "packages"
    ? path.resolve(cwd, "../..")
    : cwd;
}

export function resolveUiDocsRoot(projectRoot: string = resolveUiProjectRoot()): string {
  const envOverride = process.env.SLAD_DOCS_PATH;
  if (typeof envOverride === "string" && envOverride.trim() !== "") {
    return path.isAbsolute(envOverride) ? envOverride : path.resolve(projectRoot, envOverride);
  }

  const cfgPath = path.join(projectRoot, CONFIG_PATH);
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as { docsPath?: unknown; paths?: unknown };
    const nestedDocsPath = parsed.paths && typeof parsed.paths === "object"
      ? (parsed.paths as { docsPath?: unknown }).docsPath
      : undefined;
    const rawDocsPath = typeof nestedDocsPath === "string" ? nestedDocsPath : parsed.docsPath;
    const docsPath = typeof rawDocsPath === "string" && rawDocsPath.trim() !== ""
      ? rawDocsPath
      : LEGACY_CLI_DOCS_PATH;
    return resolveDocsPath(projectRoot, docsPath);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") {
      return defaultDocsRoot(projectRoot);
    }
    return defaultDocsRoot(projectRoot);
  }
}
