import { NextResponse } from "next/server";
import { SladSettings } from "@slad/shared";
import { validateSettings } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = SladSettings.safeParse(body.settings ?? body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  return NextResponse.json(validateSettings(parsed.data));
}
