// The project picker's data, assembled once for one app (CHE-237).
//
// This is the only place that turns "the team has a PostHog connection" into
// "here are the projects, best guess first". It lives apart from the page so
// the page stays a rendering of facts, and apart from projects.ts so that file
// stays pure and testable.
//
// Everything it returns is either a fact or an explicit absence. There is no
// "something went wrong" that renders as an empty list: an empty list means the
// account has no projects, and that is a different sentence from "we could not
// ask" (rule 2 — what we could not verify is ours to say out loud, not theirs
// to infer from a blank screen).

import type { PrismaClient } from "@/generated/prisma/client";
import { POSTHOG_REGIONS } from "./api";
import { freshPostHogToken } from "./token";
import {
  MAX_PROJECTS_TO_PROBE,
  hostsSeenBy,
  listProjects,
  rankProjects,
  suggestedProject,
  type RankedProject,
} from "./projects";

export type ProjectChoices =
  /** No PostHog connection on this team yet. The app is not broken (CHE-237). */
  | { kind: "not-connected" }
  /** We have a connection but could not use it. Says why, in the owner's terms. */
  | { kind: "unavailable"; reason: string }
  /** The real list, best guess first. `suggested` may be null — that is an answer. */
  | { kind: "ready"; projects: RankedProject[]; suggested: RankedProject | null; probed: boolean };

/** The API base for a stored region. Falls back to US, which is PostHog's own
 *  default for an account that never chose. */
export function baseUrlForRegion(region: string | null): string {
  return POSTHOG_REGIONS.find((r) => r.region === region)?.baseUrl ?? POSTHOG_REGIONS[0].baseUrl;
}

export async function projectChoicesFor(
  db: PrismaClient,
  args: { teamId: string; appUrl: string; clientId: string },
): Promise<ProjectChoices> {
  const integration = await db.postHogIntegration.findFirst({ where: { teamId: args.teamId } });
  if (!integration) return { kind: "not-connected" };

  const token = await freshPostHogToken(db, integration, { clientId: args.clientId });
  if (!token.ok) return { kind: "unavailable", reason: token.reason };

  const baseUrl = baseUrlForRegion(integration.region);
  let projects;
  try {
    projects = await listProjects({ token: token.token, baseUrl });
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `we could not read the projects on this PostHog account (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  // The suggestion costs one query per project, so it is offered only while
  // that is cheap. Past the cap the owner still gets every project by name —
  // fewer promises, same answer available.
  const probed = projects.length <= MAX_PROJECTS_TO_PROBE;
  const hostsByProject: Record<string, string[]> = {};
  if (probed) {
    await Promise.all(
      projects.map(async (p) => {
        hostsByProject[p.id] = await hostsSeenBy({ token: token.token, baseUrl, projectId: p.id });
      }),
    );
  }

  const ranked = rankProjects(args.appUrl, projects, hostsByProject);
  return { kind: "ready", projects: ranked, suggested: probed ? suggestedProject(ranked) : null, probed };
}
