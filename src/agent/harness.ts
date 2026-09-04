// CHE-169 — how the walking loop sees: with every screenshot in context, or
// with a screenshot only at a moment of judgment.
//
// Vision nav (CHE-70) killed two false-broken classes — the LiveKit call that
// "could not be driven" and the 429 "broken widget" — and cost 2.7× per
// journey (COSTS.md, CHE-131): every screenshot went into the context and was
// re-read on every iteration. The image window (CHE-130) bounded the re-reads;
// this bounds the captures. The model walks on text and is shown the page
// exactly when a judgment depends on seeing it: an inert click, an error
// response in the request log, a media page, or its own request to look.
//
// Pure: a function of the tier and of whether the nav model can take an
// image at all, so the verify script asserts both branches from Node. A text-
// only nav model gets no image either way — sending one errors the request.

import type { HarnessMode } from "./env";

export interface WalkingVision {
  // The screenshot tool parks a JPEG on every capture (today's CHE-70 walk).
  visionScreenshots: boolean;
  // The harness parks a JPEG only on a trigger (see tools.ts attachLook).
  visionTriggers: boolean;
}

export function walkingVision(mode: HarnessMode, navIsVision: boolean): WalkingVision {
  if (!navIsVision) return { visionScreenshots: false, visionTriggers: false };
  if (mode.visionOnDemand) return { visionScreenshots: false, visionTriggers: true };
  // Off: today's walk byte for byte.
  return { visionScreenshots: true, visionTriggers: false };
}
