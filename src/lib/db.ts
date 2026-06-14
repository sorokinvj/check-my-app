// Prisma client over Cloudflare D1.
//
// In the Workers runtime the D1 binding comes from the request context, so
// there is no module-level singleton — call getDb(env) with the binding. The
// web app uses getDbFromContext() to pull the binding from OpenNext's
// getCloudflareContext(); the agent worker passes its binding explicitly.

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

export interface AppBindings {
  DB: D1Database;
  EVIDENCE?: R2Bucket;
  [key: string]: unknown;
}

export function getDb(env: { DB: D1Database }): PrismaClient {
  const adapter = new PrismaD1(env.DB);
  return new PrismaClient({ adapter });
}

// Web-app convenience: resolve the binding from the Cloudflare context.
export async function getDbFromContext(): Promise<PrismaClient> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();
  return getDb(env as unknown as { DB: D1Database });
}

// Human-facing Run.runNumber. SQLite autoincrement() is PK-only, so we keep a
// single Counter row and bump it. D1 has no transactions; the read-modify-write
// races only under truly concurrent run creation. Submissions are low-rate and
// runNumber has a UNIQUE constraint, so on the rare collision we retry.
export async function nextRunNumber(db: PrismaClient): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = await db.counter.upsert({
      where: { name: "runNumber" },
      create: { name: "runNumber", value: 1 },
      update: { value: { increment: 1 } },
    });
    const candidate = counter.value;
    const clash = await db.run.findUnique({ where: { runNumber: candidate } });
    if (!clash) return candidate;
  }
  const max = await db.run.findFirst({ orderBy: { runNumber: "desc" } });
  return (max?.runNumber ?? 0) + 1;
}
