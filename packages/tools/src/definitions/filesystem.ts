import type { FileSystem } from "../types.js";
import { readFileDef, readFileExec, writeFileDef, writeFileExec, listDirDef, listDirExec, grepDef, grepExec } from "../filesystem.js";

export { readFileDef, readFileExec, writeFileDef, writeFileExec, listDirDef, listDirExec, grepDef, grepExec };

export function createFilesystemExecutors(fileSystem: FileSystem) {
  return {
    readFileExec: (args: { path: string }, cwd: string) => readFileExec(args, cwd, fileSystem),
    writeFileExec: (args: { path: string; content: string }, cwd: string) => writeFileExec(args, cwd, fileSystem),
    listDirExec: (args: { path: string; recursive?: boolean }, cwd: string) => listDirExec(args, cwd, fileSystem),
  };
}
