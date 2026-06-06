import { NextResponse } from "next/server";
import { parseSladWorkRequest } from "@slad/pipeline/slad";
import { createLocalSession, readSladUiState } from "../../../../lib/slad-server";
import { startModeJob } from "../../../../lib/slad-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseSladWorkRequest(body);

  if (!parsed) {
    return NextResponse.json({ error: "intent is required." }, { status: 400 });
  }

  // ask mode: no session needed
  if (parsed.mode === "ask") {
    const job = startModeJob({ intent: parsed.intent, mode: parsed.mode, agent: parsed.agent, model: parsed.model });
    return NextResponse.json({ jobId: job.id, mode: parsed.mode, stage: parsed.mode, status: job.status });
  }

  // work / work-debate: create session first so artifacts are tracked
  const session = createLocalSession(parsed.intent);
  const job = startModeJob({
    intent: parsed.intent,
    mode: parsed.mode,
    sessionId: session.id,
    agent: parsed.agent,
    model: parsed.model,
    debateModels: parsed.debateModels,
  });
  const state = readSladUiState();

  return NextResponse.json({
    jobId: job.id,
    mode: parsed.mode,
    stage: parsed.mode,
    status: job.status,
    session: { id: session.id, intent: session.intent },
    state,
  });
}
