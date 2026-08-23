import type { Metadata } from "next";
import Link from "next/link";
import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "CheckMyApp",
  description: "Paste a link. We'll show you your app.",
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
              <div className="flex items-center gap-4">
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
                <Show when="signed-out">
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
                    Dashboard
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
