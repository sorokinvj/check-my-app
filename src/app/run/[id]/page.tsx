import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { RunLive } from "@/components/run-live";
import { isTerminal } from "@/lib/status";

// Screen 2 — In-progress · /run/{id}
export default async function RunPage({ params }: { params: { id: string } }) {
  const run = await prisma.run.findUnique({
    where: { publicId: params.id },
    select: { publicId: true, appSlug: true, status: true },
  });
  if (!run) notFound();

  // If it already finished, jump straight to the verdict.
  if (isTerminal(run.status) && run.status !== "failed") {
    redirect(`/verdict/${run.publicId}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <RunLive publicId={run.publicId} appSlug={run.appSlug} />
    </main>
  );
}
