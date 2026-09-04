import type { Metadata } from "next";
import Link from "next/link";
import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import "./globals.css";
import { OG_IMAGE, SITE } from "@/lib/site-metadata";

const sans = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

// CHE-108: a link to this product used to paste into LinkedIn or Slack as a
// grey card with one line on it — no page carried the metadata a platform reads
// to build a preview. At launch a post IS the distribution, so the link was
// losing its clicks in the composer, before anyone reached the product at all.
//
// metadataBase makes the relative image below absolute, which every platform
// requires; templated titles let a page name itself without repeating the
// product name. Pages that want their own card use pageMetadata() from
// src/lib/site-metadata.ts — the image has to travel with them, see there.
const TAGLINE =
  "Paste a link and we check your app the way a person would — then tell you what a visitor hits.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "CheckMyApp", template: "%s · CheckMyApp" },
  description: TAGLINE,
  openGraph: {
    type: "website",
    siteName: "CheckMyApp",
    title: "CheckMyApp",
    description: TAGLINE,
    url: SITE,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "CheckMyApp",
    description: TAGLINE,
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${sans.variable} ${mono.variable}`}>
        <body className="min-h-screen">
          <header className="border-b border-ink-800">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
              <Link href="/check" className="group flex items-center gap-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 font-mono text-[13px] font-semibold text-accent transition-colors group-hover:bg-accent/25">
                  ✓
                </span>
                <span className="font-mono text-sm font-medium tracking-tight text-fg">
                  checkmyapp
                </span>
              </Link>
              {/* Signed out, this is a website and the links sell it. Signed in,
                  it is a workspace, and the same links leave the owner with no
                  idea where they are or what else is here. Two different headers
                  for two different people. */}
              <div className="flex items-center gap-4">
                <Show when="signed-out">
                  <span className="hidden font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint sm:inline">
                    product mirror · qa fallout
                  </span>
                  <Link
                    href="/pricing"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Pricing
                  </Link>
                  <Link
                    href="/faq"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    FAQ
                  </Link>
                  <Link
                    href="/about"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    About
                  </Link>
                  <SignInButton mode="modal">
                    <button className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg">
                      Sign in
                    </button>
                  </SignInButton>
                </Show>
                <Show when="signed-in">
                  <Link
                    href="/dashboard"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Your apps
                  </Link>
                  <Link
                    href="/dashboard/accuracy"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Accuracy
                  </Link>
                  <Link
                    href="/check"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Check a link
                  </Link>
                  <UserButton />
                </Show>
              </div>
            </div>
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
