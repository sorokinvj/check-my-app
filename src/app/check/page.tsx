import Link from "next/link";
import { SubmitForm } from "@/components/submit-form";
import { EXAMPLE_VERDICT_PATH } from "@/lib/example-verdict";

// Screen 1 — Submit · /check
// ?url= prefills the input (CHE-39) so saved/shared links land ready to go.
export default async function CheckPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 py-16">
      <SubmitForm initialUrl={url ?? ""} />
      {/* Issue #9: someone deciding whether to paste their own link wants to
          see what they would get first. One quiet line, under the form, to a
          public verdict of someone else's product. */}
      <p className="mt-10 w-full max-w-xl text-center font-mono text-[13px] leading-6 text-fg-faint">
        Not ready to paste your own link?{" "}
        <Link href={EXAMPLE_VERDICT_PATH} className="text-accent transition-colors hover:underline">
          See an example verdict →
        </Link>
      </p>
    </main>
  );
}
