import type { AppAnatomy } from "@/lib/types";
import type { ProposedJourney } from "./discovery";
import type { ExtensionSession } from "./extension-contract";

interface ProductRead {
  surface?: string;
  source?: string;
  balance?: number;
  controls?: Array<{ role: string; name: string; editable?: boolean; protected?: boolean }>;
}

// Native discovery saw authentication but called Show Insights a harmless
// toggle and invented backend/storage services. The installed adapter knows
// this control starts capture. That primary journey must survive extraction.
export function shapeExtensionDiscovery(identity: ExtensionSession, observations: string, proposed: ProposedJourney[]): { journeys: ProposedJourney[]; anatomy: AppAnatomy } {
  const reads: ProductRead[] = observations.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const controls = reads.flatMap(read => read.controls ?? []);
  const names = new Set(controls.map(control => control.name));
  const account = reads.some(read => read.source === "account-ui" && Number.isSafeInteger(read.balance));
  const journeys = [...proposed];
  const anatomy: AppAnatomy = {
    pages: [...new Set(reads.flatMap(read => read.surface === "native-popup" ? ["Extension popup"] : read.surface === "extension-panel" ? ["Interview assistance panel"] : read.source === "account-ui" ? ["Account"] : []))],
    actions: [...new Set(controls.filter(control => /button|link|combo box|check box/.test(control.role) && !control.protected)
      .map(control => control.name).filter(name => name && !name.includes("{{") && !name.includes("[existing document]")))],
    services: [],
    tech: { Version: identity.installedVersion },
  };
  if (identity.extensionId === "hafhjepjihcimcljkdphpinannbdmnhf") {
    journeys.length = 0;
    if (names.has("Show JobLander Insights")) journeys.push({
      title: "Interview assistance and session minutes",
      steps: [
        "Sign in to the extension with the existing test account.",
        "Read the account's minute balance and session history before starting.",
        "Start JobLander Insights on the interview page.",
        "Receive a new answer relevant to the interview question.",
        "Observe the session through its allotted duration and end it with confirmation.",
        "Check the new session's duration, minute debit and unchanged balance after Stop.",
      ],
    });
    if (names.has("Sign in with email")) journeys.push({ title: "Email sign-in", steps: [
      "Open the extension and choose Sign in with email.",
      "Sign in with the existing test account.",
      "See the account and interview-assistance controls.",
    ] });
    if (account) journeys.push({ title: "Account minutes and session history", steps: [
      "Sign in with the existing test account.",
      "Read the available minutes and previous sessions.",
    ] });
    if (names.has("Show JobLander Insights")) anatomy.actions.push("Start interview assistance");
  }
  return { journeys: journeys.slice(0, 5), anatomy };
}
