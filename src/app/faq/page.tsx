import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "FAQ — CheckMyApp",
  description:
    "How CheckMyApp explores your app, what it does with your credentials, and what you get back.",
};

// Public FAQ · /faq (CHE-63). Answers must stay accurate — no overpromising.
// API access is a Business-tier feature; trackers are Linear-only today.
type Faq = {
  q: string;
  a: ReactNode;
};

// Inline monospace token for code / commands inside answers.
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[13px] text-fg">
      {children}
    </code>
  );
}

const FAQS: Faq[] = [
  {
    q: "Can my coding agent or CI run checks automatically?",
    a: (
      <>
        Yes. Create an API key on your dashboard (Business plan) and{" "}
        <Code>POST</Code> to <Code>/api/checks</Code> with{" "}
        <Code>Authorization: Bearer cma_…</Code>. There&apos;s also an MCP server —{" "}
        <Code>claude mcp add checkmyapp</Code> — see <Code>mcp/README.md</Code>.
      </>
    ),
  },
  {
    q: "Do you look at my source code?",
    a: (
      <>
        No. The agent uses your running app in a real browser like a first-time user; it
        never reads your repo.
      </>
    ),
  },
  {
    q: "What happens to the test-login credentials I provide?",
    a: (
      <>
        Encrypted at rest, never logged, never shown in evidence. Used only so the agent can
        walk signed-in journeys.
      </>
    ),
  },
  {
    q: "Will it create real accounts or delete my data?",
    a: (
      <>
        No. Signup is walked up to the final submit but not completed unless you allow it;
        destructive actions (delete, cancel) are off-limits unless you explicitly permit them.
      </>
    ),
  },
  {
    q: "What do I actually get?",
    a: (
      <>
        A verdict page with journey-level findings, screenshots, network evidence, and
        downloadable Playwright specs. Daily Watch re-checks and files one ticket per new
        regression into your tracker.
      </>
    ),
  },
  {
    q: "How is the free tier limited?",
    a: (
      <>
        A typical full first check costs us ~$0.50 of agent compute. Free = 1 check/day
        without signup, 3 total with a free account; paid plans lift the caps.
      </>
    ),
  },
  {
    q: "Which trackers are supported?",
    a: <>Linear today (GitHub next), on Growth and above.</>,
  },
];

export default function FaqPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="stagger space-y-10">
        <div className="space-y-3">
          <p className="section-label">faq</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight">
            Questions, <span className="text-accent">answered honestly</span>.
          </h1>
          <p className="max-w-xl text-sm text-fg-muted">
            What the agent does, what it never touches, and what lands on your verdict page.
          </p>
        </div>

        <div className="space-y-4">
          {FAQS.map((faq) => (
            <div key={faq.q} className="card p-5">
              <h2 className="text-[15px] font-semibold tracking-tight text-fg">{faq.q}</h2>
              <p className="mt-2 text-sm leading-6 text-fg-muted">{faq.a}</p>
            </div>
          ))}
        </div>

        <p className="font-mono text-[13px] text-fg-faint">
          <Link href="/check" className="text-accent hover:underline">
            Check your app →
          </Link>{" "}
          · first run is free, no signup.
        </p>
      </div>
    </main>
  );
}
