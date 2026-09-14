import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contentTypeFor, getObject } from "@/lib/storage";

// GET /api/evidence/{key...} — serve evidence (screenshots, transcripts,
// generated specs) from the private R2 bucket. Keys are content-addressed
// (sha256) or run-scoped; the verdict permalink is unguessable, so proxying
// through the Worker is the MVP access boundary. Post-MVP: signed URLs / ACLs.

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const key = (await params).path.join("/");
  // Native popup masking missed a selected resume filename in the live feed.
  // Raw extension images and diagnostics stay private, including older keys.
  if (key.startsWith("private/") || key.startsWith("extensions/")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { env } = getCloudflareContext();
  const bucket = (env as unknown as { EVIDENCE?: R2Bucket }).EVIDENCE;
  if (!bucket) return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });

  const object = await getObject(bucket, key);
  if (!object) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? contentTypeFor(key),
      "Cache-Control": "private, max-age=31536000, immutable",
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    },
  });
}
