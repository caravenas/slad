import { NextResponse } from "next/server";
import { createLocalSession, readSladUiState, runAndSaveDiscovery } from "../../../lib/slad-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readSladUiState());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  if (intent.length < 3) {
    return NextResponse.json({ error: "Intent must have at least 3 characters." }, { status: 400 });
  }

  const session = createLocalSession(intent);
  runAndSaveDiscovery(session.id, { selectedAgent: agent || undefined }).catch(() => {});
  return NextResponse.json({ session, state: readSladUiState() }, { status: 201 });
}
