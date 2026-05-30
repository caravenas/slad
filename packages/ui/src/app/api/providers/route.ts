import { NextResponse } from "next/server";
import { readCliDiscovery } from "../../../lib/slad-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId") ?? undefined;
  const result = readCliDiscovery(sessionId);
  return NextResponse.json(result);
}
