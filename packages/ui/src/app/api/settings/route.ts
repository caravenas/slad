import { NextResponse } from "next/server";
import { SladSettings } from "@slad/shared";
import { readSettings, writeSettings } from "../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readSettings());
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = SladSettings.safeParse(body.settings ?? body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  writeSettings(parsed.data);
  return NextResponse.json(readSettings());
}
