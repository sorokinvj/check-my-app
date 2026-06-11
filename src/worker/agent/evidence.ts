// Evidence capture + storage. Evidence is first-class: every step/finding should
// carry verifiable artifacts. Screenshots blur password fields before storage
// (Privacy §5). Storage is S3-compatible, falling back to local disk in dev.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { EvidenceType } from "@prisma/client";

interface EvidenceInput {
  type: EvidenceType;
  storageUrl: string;
  sha256: string;
}

export async function captureEvidence(args: {
  page: Page;
  kind: "screenshot";
}): Promise<EvidenceInput | null> {
  const { page, kind } = args;
  if (kind !== "screenshot") return null;

  await blurPasswords(page);
  const buffer = await page.screenshot({ fullPage: false });
  return storeScreenshot(buffer);
}

export async function storeScreenshot(buffer: Buffer): Promise<EvidenceInput> {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const storageUrl = await putObject(`screenshots/${sha256}.png`, buffer);
  return { type: "screenshot", storageUrl, sha256 };
}

// Persist a text artifact (agent transcript, generated spec) alongside evidence.
export async function storeText(prefix: string, name: string, content: string): Promise<string> {
  return putObject(`${prefix}/${name}`, Buffer.from(content, "utf8"));
}

// Privacy §5: password fields must never be readable in evidence.
async function blurPasswords(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document
        .querySelectorAll<HTMLInputElement>('input[type="password"]')
        .forEach((el) => (el.style.filter = "blur(6px)"));
    })
    .catch(() => {});
}

// Minimal storage abstraction. TODO: swap local disk for S3/R2 when configured.
// Returns a web path served by /api/evidence/[...path] so the frontend can
// render screenshots and link artifacts directly.
async function putObject(key: string, body: Buffer): Promise<string> {
  if (process.env.STORAGE_ENDPOINT) {
    // TODO: implement S3 PutObject (AWS SDK / R2).
    throw new Error("S3 storage not implemented — configure src/worker/agent/evidence.ts");
  }
  const dir = path.join(process.cwd(), "storage", path.dirname(key));
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(process.cwd(), "storage", key);
  await fs.writeFile(filePath, body);
  return `/api/evidence/${key}`;
}
