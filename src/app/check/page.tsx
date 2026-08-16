import { SubmitForm } from "@/components/submit-form";

// Screen 1 — Submit · /check
// ?url= prefills the input (CHE-39) so saved/shared links land ready to go.
export default async function CheckPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-16">
      <SubmitForm initialUrl={url ?? ""} />
    </main>
  );
}
