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
