import { NextResponse } from "next/server";
import { killJob } from "../../../../lib/slad-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }
  const killed = killJob(jobId);
  if (!killed) {
    return NextResponse.json({ error: "Job not found or not running." }, { status: 404 });
  }
  return NextResponse.json({ cancelled: true, jobId });
}
