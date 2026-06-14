import { getDbFromContext } from "@/lib/db";
import { isTerminal } from "@/lib/status";

export const dynamic = "force-dynamic";

// GET /api/runs/{publicId}/stream — Server-Sent Events feed for the live screen.
// Polls the run row and emits a `snapshot` event whenever status/events change,
// then closes once the run reaches a terminal state. (MVP simplicity over a
// pub/sub fan-out — swap for Redis pub/sub when scaling.)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastSerialized = "";

      const tick = async () => {
        const run = await prisma.run.findUnique({
          where: { publicId: (await params).id },
          select: {
            status: true,
            events: true,
            verdict: true,
            errorMessage: true,
            currentAction: true,
            liveScreenshotUrl: true,
          },
        });
        if (!run) {
          controller.enqueue(encoder.encode(`event: error\ndata: not_found\n\n`));
          controller.close();
          return true;
        }
        const serialized = JSON.stringify(run);
        if (serialized !== lastSerialized) {
          lastSerialized = serialized;
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
        }
        if (isTerminal(run.status)) {
          controller.enqueue(encoder.encode(`event: done\ndata: ${run.status}\n\n`));
          controller.close();
          return true;
        }
        return false;
      };

      if (await tick()) return;
      const interval = setInterval(async () => {
        if (await tick()) clearInterval(interval);
      }, 2000);
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
