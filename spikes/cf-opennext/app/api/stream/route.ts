// CHE-22 spike — does @opennextjs/cloudflare preserve SSE streaming on Workers?
// This mirrors our real /api/runs/{id}/stream: a long-lived text/event-stream
// that emits events over time. The test is whether events arrive INCREMENTALLY
// (truly streamed) vs buffered into one chunk at the end.
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 1; i <= 5; i++) {
        const payload = JSON.stringify({ i, at: new Date().toISOString() });
        controller.enqueue(encoder.encode(`event: tick\ndata: ${payload}\n\n`));
        await new Promise((r) => setTimeout(r, 500));
      }
      controller.enqueue(encoder.encode(`event: done\ndata: end\n\n`));
      controller.close();
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
