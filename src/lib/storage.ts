// Evidence/artifact storage on Cloudflare R2 (CHE-12).
//
// One module shared by both planes: the agent worker PUTs screenshots,
// transcripts and generated specs; the web app's /api/evidence/[...path] route
// GETs them. Keys are content-addressed (sha256) or run-scoped, so the
// unguessable key + the private verdict permalink are the MVP access boundary —
// the bucket stays private and is proxied through the Worker (no public URLs).
// Real signed URLs / per-tenant ACLs are post-MVP.

export const EVIDENCE_PATH_PREFIX = "/api/evidence/";

export function evidenceUrl(key: string): string {
  return EVIDENCE_PATH_PREFIX + key.replace(/^\/+/, "");
}

// The inverse: the R2 key behind a stored evidence URL, or null when the URL
// is not ours (an external link, an absolute URL from an older deployment).
export function evidenceKey(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(EVIDENCE_PATH_PREFIX)) return null;
  const key = url.slice(EVIDENCE_PATH_PREFIX.length);
  return key.length > 0 ? key : null;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webm: "video/webm",
  json: "application/json",
  ts: "text/plain; charset=utf-8",
  har: "application/json",
  txt: "text/plain; charset=utf-8",
};

export function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Store an object and return the web path the frontend links/renders.
export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
): Promise<string> {
  await bucket.put(key, body, {
    httpMetadata: { contentType: contentTypeFor(key) },
  });
  return evidenceUrl(key);
}

export async function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

// R2 accepts up to 1000 keys per delete call.
const DELETE_BATCH = 1000;

// Remove objects. The caller decides that nothing references the keys any more
// (screenshots are content-addressed and may be shared between runs — see
// src/lib/ephemeral.ts); this only does the deleting, in batches.
export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + DELETE_BATCH));
  }
}
