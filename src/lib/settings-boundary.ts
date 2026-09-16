// CHE-277: where a setting lives, decided once.
//
// Agreed between the two sessions that own the surfaces (the owner asked for
// the boundary to be settled before either page existed). Three questions, and
// the third one settles the cases the first two argue about:
//
//   1. does changing this alter what a colleague sees?
//   2. does it survive me leaving?
//   3. **who pays for the consequence?**
//
// The first two describe the blast radius. The third names what is at stake,
// and it is the one that decides the hard cases — an API key looks personal by
// the first two ("I made it, it is mine") and is obviously not by the third: a
// key is spending authority in an envelope.
//
// And the rule that stops this being re-litigated every time somebody adds an
// integration:
//
//   **Settings are about the team or the person. Anything about ONE APP lives
//   on that app.**
//
// So the Linear team and the PostHog project sit in the app's own row on the
// dashboard, not here. They are properties of an app, the way its URL and its
// credentials are — and a settings page listing four apps × three integrations
// answers "where do I change this?" with "somewhere else".

export type SettingsHome = "team" | "personal" | "the app itself";

export type SettingDefinition = {
  key: string;
  home: SettingsHome;
  // One sentence a person could disagree with — the reason, not the rule.
  because: string;
};

export const SETTINGS: SettingDefinition[] = [
  // ─── The team's: one person spends the team's money, access or credibility ──
  { key: "members and their scopes", home: "team", because: "it decides what a colleague can do" },
  { key: "invitations", home: "team", because: "it adds someone who can spend the plan" },
  { key: "billing and seats", home: "team", because: "it is the team's money" },
  { key: "api keys", home: "team", because: "a key is spending authority in an envelope, and it outlives whoever minted it" },
  { key: "analytics connection", home: "team", because: "one token, read by every app the team watches" },
  { key: "outbound webhooks and slack", home: "team", because: "it sends the team's findings somewhere everyone sees" },
  { key: "team name", home: "team", because: "it is what colleagues and invitations call this team" },
  { key: "delete the team", home: "team", because: "it ends the thing everyone else is working in" },

  // ─── Yours: it stops at you ─────────────────────────────────────────────────
  { key: "which apps notify me", home: "personal", because: "it changes nobody's mail but mine" },
  { key: "my active team", home: "personal", because: "it decides which team I am acting as, in this browser" },
  { key: "leaving a team", home: "personal", because: "it removes my access and nothing I did" },
  { key: "my name, email and sign-in", home: "personal", because: "it is my account, not the team's" },

  // ─── Neither: they belong to one app ───────────────────────────────────────
  { key: "the app's tracker project", home: "the app itself", because: "it is a property of that app, like its URL" },
  { key: "the app's analytics project", home: "the app itself", because: "it is a property of that app, like its credentials" },
  { key: "test credentials", home: "the app itself", because: "they are that app's, and they live where the app is configured" },
  { key: "write mode", home: "the app itself", because: "it is consent about one product, given per app" },
];

export function homeOf(key: string): SettingsHome | null {
  return SETTINGS.find((s) => s.key === key)?.home ?? null;
}
