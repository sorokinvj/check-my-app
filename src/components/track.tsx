"use client";

// Two small client components so server-rendered pages can emit product
// events without becoming client components themselves (src/lib/analytics.ts
// holds the catalogue; these only carry a name and its typed props).
//
// - <TrackOnView event="…" props={…} /> — one event per mount: a page was
//   viewed. Renders nothing.
// - <TrackedLink event="…" props={…} href=…> — a Next <Link> that records the
//   click before navigation. The event is queued synchronously by the SDK, so
//   a same-document navigation never loses it; a full-page one is flushed by
//   the SDK's pagehide handling.

import { useEffect } from "react";
import Link from "next/link";
import type { ComponentProps } from "react";
import { track, type AnalyticsEvent, type TrackArgs } from "@/lib/analytics";

type EventProps<E extends AnalyticsEvent> = TrackArgs<E> extends [infer P] ? { props: P } : { props?: undefined };

export function TrackOnView<E extends AnalyticsEvent>({ event, props }: { event: E } & EventProps<E>) {
  // Serialised so the effect re-runs only when the payload changes, not on
  // every parent render that rebuilds the object.
  const key = JSON.stringify(props ?? null);
  useEffect(() => {
    (track as (e: E, p?: unknown) => void)(event, props);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, key]);
  return null;
}

export function TrackedLink<E extends AnalyticsEvent>({
  event,
  props,
  onClick,
  ...link
}: { event: E } & EventProps<E> & ComponentProps<typeof Link>) {
  return (
    <Link
      {...link}
      onClick={(e) => {
        (track as (e: E, p?: unknown) => void)(event, props);
        onClick?.(e);
      }}
    />
  );
}
