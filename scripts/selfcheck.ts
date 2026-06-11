// Dogfood bootstrap (CHE-1): check-my-app checks itself.
//
//   npm run selfcheck                       # target http://localhost:3000
//   npm run selfcheck -- https://other.app  # any target
//
// Requires the web app (npm run dev) and the worker (npm run worker) running.
// The scope hint below is the recursion guard: the agent explores our /check
// form but must not create new runs from inside the run.

import "dotenv/config";

const target = process.argv[2] ?? "http://localhost:3000";
const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

async function main() {
  const res = await fetch(`${base}/api/checks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: target,
      userNotes:
        "Self-check (dogfood). Explore everything, including the submit form UI, " +
        "but DO NOT click the final submit button on /check — submitting would " +
        "create recursive check runs. Read-only on /watch settings: do not pause, " +
        "cancel or change frequency. Marking findings on the demo verdict is allowed.",
      scopeHints: "Do not POST /api/checks. Do not DELETE anything.",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /api/checks failed: ${res.status} ${body}`);
  }

  const { id } = (await res.json()) as { id: string };
  console.log(`Self-check queued.`);
  console.log(`  live:    ${base}/run/${id}`);
  console.log(`  verdict: ${base}/verdict/${id} (when done)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
