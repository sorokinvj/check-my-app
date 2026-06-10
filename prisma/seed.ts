// Demo seed: one completed joblander.app run matching the mockup content, so the
// verdict/run/watch screens can be developed and eyeballed without a real agent
// run. Idempotent: wipes and re-creates the demo app's data.
//   npx tsx prisma/seed.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SLUG = "joblander.app";

async function main() {
  await prisma.run.deleteMany({ where: { appSlug: SLUG } });
  await prisma.watch.deleteMany({ where: { appSlug: SLUG } });

  const run = await prisma.run.create({
    data: {
      publicId: "demo-verdict",
      targetUrl: "https://joblander.app",
      appSlug: SLUG,
      notifyEmail: "vlad@example.com",
      status: "completed",
      verdict: "mostly_ok",
      bottomLine:
        "Core product works and feels coherent — but mobile signup is broken and the AI coach has no rate limit.",
      startedAt: new Date(Date.now() - 134 * 60 * 1000),
      completedAt: new Date(),
      appLens: {
        oneLiner:
          "joblander.app is an AI-powered interview prep platform for job seekers practicing technical and behavioral interviews.",
        whoFor: "people preparing for software engineering interviews",
        coreValue: "practice mock interviews with AI coaches, get feedback",
        businessModel: "freemium SaaS — paid tier unlocks more sessions",
        techSurface: "Next.js web app + Chrome extension companion",
        criticalPaths: [
          "Sign up → first mock interview (activation)",
          "Mock interview → AI coach feedback (core loop)",
          "Free → paid conversion (revenue)",
        ],
        ifItBreaks: "lost signups, AI cost abuse, mid-session churn",
      },
      anatomy: {
        pages: [
          "/", "/signup", "/login", "/dashboard", "/interview/new", "/mock/start",
          "/interview/{id}", "/coach", "/pricing", "/settings", "/profile", "/admin",
          "/api/health", "/404",
        ],
        actions: [
          "Sign up", "Log in", "Log out", "Start mock interview", "Choose role",
          "Record audio answer", "Get coach feedback", "Browse pricing tiers",
          "Edit profile", "Change password", "Download transcript", "Invite a friend",
        ],
        services: [
          { name: "Stripe", role: "payment processing" },
          { name: "Supabase", role: "auth + database" },
          { name: "Posthog", role: "analytics" },
          { name: "Anthropic API", role: "AI coach (Claude)" },
          { name: "Cloudflare R2", role: "audio recording storage" },
        ],
        tech: {
          frontend: "Next.js 14 (App Router) · Tailwind · shadcn",
          hosting: "Vercel (or Cloud Run — couldn't tell from headers)",
          auth: "Supabase Auth",
          realtime: "WebSockets (probably for coach session)",
        },
      },
      events: [
        { at: new Date().toISOString(), phase: "writing", icon: "ok", text: "Verdict written" },
      ],
    },
  });

  await prisma.journey.create({
    data: {
      runId: run.id,
      order: 0,
      title: "Sign up → first mock interview",
      status: "broken",
      summary: "signup fails on Safari mobile (~18% of your traffic)",
      steps: {
        create: [
          { order: 0, label: "Land on homepage", status: "ok", attempted: "Open joblander.app", observed: "Homepage loaded in 1.2s" },
          { order: 1, label: 'Click "Get started"', status: "ok", attempted: "Click primary CTA", observed: "Signup form appeared" },
          { order: 2, label: "Enter email + password", status: "ok", attempted: "Fill the signup form", observed: "Fields validated inline" },
          { order: 3, label: "Verify email", status: "risky", attempted: "Wait for the verification email", observed: "Took 94s to arrive — users may bounce" },
          {
            order: 4, label: "Try mock interview on iPhone → 500", status: "broken",
            attempted: "Submit signup on iPhone Safari simulation",
            observed: "POST /api/auth/signup → 500 FUNCTION_INVOCATION_TIMEOUT",
            consoleLog: "Failed to load resource: the server responded with a status of 500",
            networkLog: "POST /api/auth/signup → 500 (10003ms)",
          },
          { order: 5, label: "(couldn't reach this step)", status: "skipped" },
        ],
      },
    },
  });

  await prisma.journey.create({
    data: {
      runId: run.id,
      order: 1,
      title: "Mock interview → AI coach feedback",
      status: "risky",
      summary: "audio cuts at 30s consistently. Coach has no rate limit (could be abused).",
      steps: {
        create: [
          { order: 0, label: "Login", status: "ok" },
          { order: 1, label: "Dashboard", status: "ok" },
          { order: 2, label: '"Start Mock Interview"', status: "ok" },
          { order: 3, label: "Pick role (e.g. swe)", status: "ok" },
          { order: 4, label: "Speak answer — audio cuts at 30s", status: "risky", attempted: "Record a 60s answer", observed: "Recording stopped at exactly 30s, no error shown" },
          { order: 5, label: "Audio uploaded", status: "ok" },
          { order: 6, label: "Get feedback", status: "ok" },
        ],
      },
    },
  });

  await prisma.journey.create({
    data: {
      runId: run.id,
      order: 2,
      title: "Free → paid (browse pricing)",
      status: "confusing",
      summary: "pricing page shows 4 tiers but the CTA on two of them goes to the same checkout.",
      steps: {
        create: [
          { order: 0, label: "Open /pricing", status: "ok" },
          { order: 1, label: "Compare tiers", status: "confusing", attempted: "Understand tier differences", observed: "Pro and Team list identical features" },
          { order: 2, label: "Click upgrade", status: "ok" },
        ],
      },
    },
  });

  await prisma.finding.createMany({
    data: [
      {
        runId: run.id, number: 1, category: "broken", severity: "high",
        title: "Sign up returns 500 on Safari mobile",
        detail: {
          where: "POST /api/auth/signup → 500",
          browser: "Mobile Safari simulation (iPhone 14)",
          reproduced: 3,
          whatWeTried: [
            "Open joblander.app on iPhone Safari",
            'Click "Get started"',
            "Enter test+ckma@mail.checkmyapp.io",
            'Enter password "TestPass1234!"',
            'Click "Create account"',
          ],
          whatHappened:
            'Response: 500 — {"error":"FUNCTION_INVOCATION_TIMEOUT"}\nConsole: "Failed to load resource: 500"\nTime-to-fail: 10003ms — looks like a function cold-start',
          whyItMatters:
            "~18% of joblander mobile traffic is iOS Safari (industry avg). These users can't sign up at all. Acquisition leak.",
        },
      },
      {
        runId: run.id, number: 2, category: "broken", severity: "medium",
        title: "Mock interview audio cuts at 30s mark",
        detail: {
          where: "MediaRecorder stream, /mock/session",
          reproduced: 4,
          whatHappened: "Recording silently stops at 30.0s; the UI keeps showing the red dot.",
          whyItMatters: "Answers longer than 30s are truncated — core-loop quality degrades invisibly.",
        },
      },
      {
        runId: run.id, number: 3, category: "risky", severity: "high",
        title: "AI coach endpoint has no rate limit",
        detail: {
          where: "POST /api/coach/feedback",
          whatHappened: "60 requests/min accepted from one session without backoff or 429.",
          whyItMatters: "Anthropic API cost abuse: one script could burn your monthly budget overnight.",
        },
      },
      {
        runId: run.id, number: 4, category: "confusing", severity: "low",
        title: "Pro and Team tiers list identical features",
        detail: { where: "/pricing", whyItMatters: "Users can't tell what they'd pay more for — conversion friction." },
      },
      {
        runId: run.id, number: 5, category: "polish", severity: "low",
        title: "404 page has no link back to the dashboard",
        detail: { where: "/404" },
      },
      {
        runId: run.id, number: 6, category: "exposed", severity: "high",
        title: "/admin returns 200 for a logged-in test user",
        detail: {
          where: "GET /admin → 200",
          whatHappened: "The admin dashboard shell renders for a non-admin account (data calls 403).",
          whyItMatters: "Information disclosure: internal nav, feature names and metrics endpoints are visible.",
        },
      },
    ],
  });

  console.log(`Seeded demo run: /verdict/demo-verdict (${SLUG})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
