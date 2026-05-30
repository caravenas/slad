import { NextResponse } from "next/server";
import path from "node:path";
import { readTrustConfig, trustWorkspace, SLAD_ROOT } from "../../../lib/slad-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = readTrustConfig();
  const active = cfg.activeWorkspace ?? SLAD_ROOT;
  const trusted = cfg.trustedPaths.some(t => active === t || active.startsWith(t + path.sep));
  return NextResponse.json({
    trusted,
    activeWorkspace: active,
    trustedPaths: cfg.trustedPaths,
    defaultPath: SLAD_ROOT,
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath.trim() : "";
  if (!workspacePath) {
    return NextResponse.json({ error: "workspacePath is required." }, { status: 400 });
  }
  const cfg = trustWorkspace(workspacePath);
  return NextResponse.json({ trusted: true, activeWorkspace: workspacePath, trustedPaths: cfg.trustedPaths });
}
