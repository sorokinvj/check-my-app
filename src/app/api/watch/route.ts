import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { enableWatchForRun } from "@/lib/watch-enable";
import { createWatchSchema } from "@/lib/validation";

// POST /api/watch — Loop B: enable Daily Watch from a verdict. Owner feature
// (CHE-33): requires auth; finds-or-creates the owner's App for the run's target,
// then upserts the owned Watch (keyed by appId, not the global appSlug — CHE-36).
// Logic shared with the verdict page's server action (CHE-75) in lib/watch-enable.
export async function POST(req: Request) {
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);

  const json = await req.json().catch(() => null);
  const parsed = createWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const result = await enableWatchForRun(db, user, {
    runPublicId: parsed.data.runId,
    frequency: parsed.data.frequency,
    notifyOnChangeOnly: parsed.data.notifyOnChangeOnly,
  });
  switch (result.kind) {
    case "unauthenticated":
      return NextResponse.json({ error: "Sign in to enable Daily Watch" }, { status: 401 });
    case "not_found":
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    case "forbidden":
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    case "gated":
      return NextResponse.json({ error: result.reason }, { status: 403 });
    case "ok":
      return NextResponse.json({ slug: result.slug }, { status: 201 });
  }
}
