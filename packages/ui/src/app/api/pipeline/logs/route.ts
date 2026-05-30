import { getJob, subscribeToJob, type JobEvent } from "../../../../lib/slad-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encode(event: JobEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId") ?? "";
  const job = getJob(jobId);
  if (!job) {
    return new Response("job not found\n", { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const log of job.logs) {
        controller.enqueue(encoder.encode(encode({ type: "log", ...log })));
      }
      controller.enqueue(
        encoder.encode(encode({ type: "status", status: job.status, exitCode: job.exitCode })),
      );

      if (job.status !== "running") {
        controller.close();
        return;
      }

      const unsubscribe = subscribeToJob(job, (event) => {
        controller.enqueue(encoder.encode(encode(event)));
        if (event.type === "status") {
          unsubscribe();
          controller.close();
        }
      });
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
