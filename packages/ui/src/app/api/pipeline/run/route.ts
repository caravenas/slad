import { NextResponse } from "next/server";
import { parseSladPipelineRunRequest } from "@slad/pipeline/slad";
import { readSladUiState } from "../../../../lib/slad-server";
import { startPipelineJob } from "../../../../lib/slad-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseSladPipelineRunRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "sessionId and stage are required." }, { status: 400 });
  }

  const state = readSladUiState();
  const session = state.sessions.find((item) => item.id === parsed.sessionId);
  if (!session) {
    return NextResponse.json({ error: `Unknown session: ${parsed.sessionId}` }, { status: 404 });
  }

  const job = startPipelineJob({
    sessionId: parsed.sessionId,
    intent: session.intent,
    stage: parsed.stage,
    agent: parsed.agent,
    model: parsed.model,
    harness: parsed.harness,
  });
  return NextResponse.json({ jobId: job.id, stage: job.stage, status: job.status });
}
