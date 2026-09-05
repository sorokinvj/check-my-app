// Today's free checks — the public list behind /checks/today and
// GET /api/checks/today (owner decision 2026-09-05: the site runs a fixed number
// of free anonymous checks a day, every one of them public, and a visitor who
// arrives after the cap can read them instead of running their own).
//
// One query shape for both the page and the API so they never disagree about
// what "today" is or what a row carries.

import type { PrismaClient } from "@/generated/prisma/client";
import { anonRunsToday } from "@/lib/plans";

export const TODAY_LIST_MAX = 50;
const EXCERPT_CHARS = 240;

export type TodayRun = {
  publicId: string;
  appSlug: string;
  verdict: string | null;
  status: string;
  bottomLine: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type TodayChecks = {
  used: number;
  cap: number;
  left: number;
  // Midnight UTC after `now`, when the free checks open again.
  resetsAt: string;
  runs: TodayRun[];
};

export function excerpt(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= EXCERPT_CHARS ? t : `${t.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
}

export async function todayChecks(db: PrismaClient, now: Date = new Date()): Promise<TodayChecks> {
  const site = await anonRunsToday(db, now);
  const dayStart = new Date(site.dayStartIso);
  const resetsAt = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  // A run that failed on our side has no verdict to read and is not the
  // customer's product speaking (CLAUDE.md rule 4), so it stays out of the
  // public list. It still counts against the cap above — it was started.
  const rows = await db.run.findMany({
    where: { ownerId: null, createdAt: { gte: dayStart }, status: { not: "failed" } },
    orderBy: { createdAt: "desc" },
    take: TODAY_LIST_MAX,
    select: {
      publicId: true,
      appSlug: true,
      verdict: true,
      status: true,
      bottomLine: true,
      createdAt: true,
      completedAt: true,
    },
  });
  return {
    used: site.used,
    cap: site.cap,
    left: Math.max(0, site.cap - site.used),
    resetsAt: resetsAt.toISOString(),
    runs: rows.map((r) => ({
      publicId: r.publicId,
      appSlug: r.appSlug,
      verdict: r.verdict,
      status: r.status,
      bottomLine: excerpt(r.bottomLine),
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  };
}

// "just now", "12 min ago", "3 h ago" — the list is one day long, so hours are
// the largest unit it needs.
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diffMin = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const h = Math.floor(diffMin / 60);
  return `${h} h ago`;
}
