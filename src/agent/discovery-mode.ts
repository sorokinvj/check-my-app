// CHE-135 — how the discovery loop runs: with or without thinking, with or
// without screenshots in the model's context.
//
// Discovery is exploration, not reasoning-critical: it navigates, reads pages
// and proposes journeys, and its output is validated by the structured
// extraction afterwards regardless of how the exploration went. Yet it ran with
// adaptive thinking on every call and a JPEG of every screenshot in context,
// the way walking did before CHE-58 E3 and CHE-130. E5 in COSTS.md queued
// exactly this experiment; the switch is DISCOVERY_LEAN (env.ts).
//
// Pure: a function of two booleans, so the verify script can assert both
// branches from Node without a browser or a model.

export interface DiscoveryLoopMode {
  thinking: "adaptive" | "off";
  visionScreenshots: boolean;
  imageWindow: number | undefined;
}

export function discoveryLoopMode(lean: boolean, navIsVision: boolean): DiscoveryLoopMode {
  if (lean) {
    // `imageWindow: 0` is belt-and-braces: with visionScreenshots off the
    // screenshot tool parks no JPEG, and 0 guarantees no image block survives
    // into the next call even if one did.
    return { thinking: "off", visionScreenshots: false, imageWindow: 0 };
  }
  // Not lean: today's behaviour byte for byte — adaptive thinking, screenshots
  // in context whenever the nav model can see them (CHE-70), never trimmed.
  return { thinking: "adaptive", visionScreenshots: navIsVision, imageWindow: undefined };
}
