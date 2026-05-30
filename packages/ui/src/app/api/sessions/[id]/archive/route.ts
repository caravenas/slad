import { NextResponse } from "next/server";
import { archiveSessionById } from "../../../../../lib/session-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Session id is required." }, { status: 400 });
  }

  try {
    const result = archiveSessionById(id);
    return NextResponse.json(
      {
        ok: true,
        sessionId: id,
        archivedAt: result.archivedAt,
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    return NextResponse.json({ error: `Failed to archive session: ${(err as Error).message}` }, { status: 500 });
  }
}
