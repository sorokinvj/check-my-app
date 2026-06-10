import { chromium, type Browser } from "playwright";

// Desktop Chromium only for MVP (Mockups: "desktop Chromium only").
// Mobile-emulation contexts (for Safari-mobile-class findings) are created per
// journey from this browser when needed.
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}
