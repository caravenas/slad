import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function POST() {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Selecciona el directorio del workspace")',
    ]);
    const folderPath = stdout.trim().replace(/\/$/, "");
    return NextResponse.json({ path: folderPath });
  } catch (err: unknown) {
    // User cancelled the dialog — osascript exits with code 1
    if ((err as { code?: number }).code === 1) {
      return NextResponse.json({ path: null });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
