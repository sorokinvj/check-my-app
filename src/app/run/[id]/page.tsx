import { notFound, redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { RunLive } from "@/components/run-live";
import { isTerminal } from "@/lib/status";

export const dynamic = "force-dynamic";

// Screen 2 — In-progress · /run/{id}
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({
    where: { publicId: (await params).id },
    select: {
      publicId: true,
      appSlug: true,
      status: true,
      runNumber: true,
      startedAt: true,
      notifyEmail: true,
    },
  });
  if (!run) notFound();

  // If it already finished, jump straight to the verdict.
  if (isTerminal(run.status) && run.status !== "failed") {
    redirect(`/verdict/${run.publicId}`);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <RunLive
        publicId={run.publicId}
        appSlug={run.appSlug}
        runNumber={run.runNumber}
        startedAt={run.startedAt.toISOString()}
        notifyEmail={run.notifyEmail}
      />
    </main>
  );
}
