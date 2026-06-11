import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/tests/{id} — download a generated Playwright spec (CHE-8 artifact).
// Content lives in the DB (versioned, sha256); this serves it as a .spec.ts.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const test = await prisma.generatedTest.findUnique({ where: { id: params.id } });
  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fileSlug =
    test.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey";

  return new Response(test.content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileSlug}.spec.ts"`,
      "X-Content-Sha256": test.sha256,
    },
  });
}
