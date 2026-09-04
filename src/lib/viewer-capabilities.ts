// CHE-108: which verdict controls a viewer is offered. The page mirrors the
// server's gates exactly — no stricter, no looser — so a stranger who opened a
// shared link is not handed the owner's buttons, and the owner is never denied
// one the server would honour.
//
// A verdict link is public by design. Before this, every visitor saw "Full
// re-check", "Enable Daily Watch" and the triage row on somebody else's app;
// the server refused them, but a control that fails on click is the exact
// defect this product flags on other people's apps.
//
// One rule per control, each naming the server check it copies. Anything not
// listed here is not gated by the page. Pure, so scripts/verify-viewer-
// capabilities.ts can exercise every combination without a database.

export type ViewerCapabilities = {
  // Re-check now — canMutateOwned (src/lib/recheck.ts): an anonymous run is
  // mutable by anyone holding the link (CHE-33), an owned run only by its owner.
  recheck: boolean;
  // Full re-check — never on an anonymous run (src/lib/recheck.ts, CHE-94);
  // on an owned run, canMutateOwned.
  fullRecheck: boolean;
  // Enable Daily Watch — src/lib/watch-enable.ts: sign-in required (the action
  // redirects there, so an anonymous visitor on an anonymous run keeps the
  // button — it is the conversion path); an anonymous run may be adopted by any
  // signed-in user; an owned run only by its owner. Once watched, the page
  // links to the watch instead, and that is not a mutation.
  enableWatch: boolean;
  // Watch settings — the link a watched run shows in place of Enable Daily
  // Watch. /watch/{slug} is requireUser + the viewer's own App with a watch,
  // so only the run's owner can open it.
  watchSettings: boolean;
  // That's fine / Watch it / Mark as fixed / Dispute — PATCH /api/findings/{id}
  // is canMutateOwned, same as Re-check now.
  markFindings: boolean;
  // Create Ticket — POST /api/findings/{id}/ticket needs the viewer's own App
  // row for the run's appSlug AND (anonymous run OR viewer is the owner).
  createTicket: boolean;
  // Export to GitHub — POST /api/runs/{id}/export-specs: sign-in required (the
  // component redirects there), then an owned run only by its owner. Same
  // shape as Enable Daily Watch, including the anonymous conversion path.
  exportSpecs: boolean;
};

export function viewerCapabilities(input: {
  run: { ownerId: string | null; hasWatch: boolean };
  viewer: { id: string } | null;
  // The signed-in viewer's App row for run.appSlug, or null. Exists only after
  // onboarding or Enable Daily Watch — which is why it gates Create Ticket and
  // nothing else: the real owner of a fresh run has no App row yet.
  viewerApp: { id: string } | null;
  // The result of canMutateOwned(db, run.ownerId), computed by the caller.
  canMutate: boolean;
}): ViewerCapabilities {
  const { run, viewer, viewerApp, canMutate } = input;
  const owned = run.ownerId !== null;
  const isOwner = owned && viewer !== null && viewer.id === run.ownerId;
  const anonymousOrOwner = !owned || isOwner;

  return {
    recheck: canMutate,
    fullRecheck: owned && canMutate,
    enableWatch: !run.hasWatch && anonymousOrOwner,
    watchSettings: run.hasWatch && isOwner,
    markFindings: canMutate,
    createTicket: viewerApp !== null && anonymousOrOwner,
    exportSpecs: anonymousOrOwner,
  };
}
