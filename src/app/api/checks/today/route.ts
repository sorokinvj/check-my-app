import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { todayChecks } from "@/lib/checks-today";
import { effectiveSiteCap } from "@/lib/site-cap";

// GET /api/checks/today — today's free anonymous checks and how many are left
// (owner decision 2026-09-05: a site-wide daily cap on free checks, every
// anonymous check public). No auth: the submit form reads it on mount to show
// the counter, and /checks/today is the page version of the same data.
export const dynamic = "force-dynamic";

export async function GET() {
  const prisma = await getDbFromContext();
  const body = await todayChecks(prisma, new Date(), effectiveSiteCap());
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
