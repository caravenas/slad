import { NextResponse } from "next/server";
import { parseSladHumanAnswersRequest } from "@slad/pipeline";
import { readSladUiState, saveHumanAnswers } from "../../../../lib/slad-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseSladHumanAnswersRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "sessionId, stage and answers are required." }, { status: 400 });
  }

  saveHumanAnswers({
    sessionId: parsed.sessionId,
    stage: parsed.stage,
    taskId: parsed.taskId,
    answers: parsed.answers,
  });
  return NextResponse.json({ state: readSladUiState() });
}
