// Phase 4 — Walking journeys.
//
// For each proposed journey, walk it step by step. Per step: capture a screenshot,
// record what was attempted/observed plus console + network, classify the outcome
// (ok / risky / confusing / broken / exposed / skipped), and persist Step + Evidence.
// The journey's roll-up status is the worst-case of its steps.

import type { Browser } from "playwright";
import { prisma } from "@/lib/db";
import type { StepStatus } from "@prisma/client";
import { captureEvidence } from "./evidence";
import type { ProposedJourney } from "./discovery";

const SEVERITY_ORDER: StepStatus[] = [
  "ok",
  "skipped",
  "confusing",
  "risky",
  "exposed",
  "broken",
];

function worstStatus(statuses: StepStatus[]): StepStatus {
  return statuses.reduce<StepStatus>((worst, s) => {
    return SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst;
  }, "ok");
}

export async function walkJourneys(args: {
  runId: string;
  browser: Browser;
  journeys: ProposedJourney[];
}): Promise<void> {
  const { runId, browser, journeys } = args;

  for (const [index, proposed] of journeys.entries()) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const stepStatuses: StepStatus[] = [];

    try {
      const journey = await prisma.journey.create({
        data: {
          runId,
          order: index,
          title: proposed.title,
          status: "ok",
        },
      });

      for (const [stepIndex, proposedStep] of proposed.steps.entries()) {
        // TODO: drive the page to perform proposedStep using the agent loop,
        // observe the result, and classify the outcome.
        const status: StepStatus = "ok"; // placeholder

        const screenshot = await captureEvidence({ page, kind: "screenshot" });

        await prisma.step.create({
          data: {
            journeyId: journey.id,
            order: stepIndex,
            label: proposedStep.label,
            status,
            evidence: screenshot ? { create: [screenshot] } : undefined,
          },
        });
        stepStatuses.push(status);
      }

      await prisma.journey.update({
        where: { id: journey.id },
        data: { status: worstStatus(stepStatuses) },
      });
    } finally {
      await context.close();
    }
  }
}
