import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VersionError } from "../core/errors.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(thisDir, "../../package.json");

type PackageJsonVersion = {
  version?: unknown;
};

/**
 * Returns the exact CLI version output format.
 */
export async function getFormattedCliVersion(): Promise<string> {
  let raw: string;

  try {
    raw = await readFile(packageJsonPath, "utf-8");
  } catch (error) {
    throw new VersionError("No se pudo leer package.json para resolver la versión.", {
      path: packageJsonPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: PackageJsonVersion;
  try {
    parsed = JSON.parse(raw) as PackageJsonVersion;
  } catch (error) {
    throw new VersionError("package.json contiene JSON inválido.", {
      path: packageJsonPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new VersionError("package.json no contiene un campo version válido.", {
      path: packageJsonPath,
      receivedType: typeof parsed.version,
    });
  }

  return `slad ${parsed.version}`;
}
