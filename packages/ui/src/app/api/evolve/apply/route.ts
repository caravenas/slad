import { NextResponse } from "next/server";
import { applyEvolveDecisions, readSladUiState, readTrustConfig } from "../../../../lib/slad-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const decisions =
    body.decisions && typeof body.decisions === "object" && !Array.isArray(body.decisions)
      ? (body.decisions as Record<string, unknown>)
      : {};

  if (!sessionId || Object.keys(decisions).length === 0) {
    return NextResponse.json({ error: "sessionId and decisions are required." }, { status: 400 });
  }

  const normalized: Record<string, "apply" | "reject"> = {};
  for (const [k, v] of Object.entries(decisions)) {
    if (v === "apply" || v === "reject") normalized[k] = v;
  }

  try {
    const cfg = readTrustConfig();
    const { applied, errors } = applyEvolveDecisions(sessionId, normalized, cfg.activeWorkspace);
    return NextResponse.json({ applied, errors, state: readSladUiState() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
