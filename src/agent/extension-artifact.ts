function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pick(value: unknown, keys: string[]): Record<string, unknown> {
  const input = record(value);
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}

// The durable recovery record may need the original account snapshot. A
// verdict artifact must never expose unrelated sessions from that account.
export function extensionArtifactEvidence(value: unknown) {
  const final = record(value), session = record(final.session);
  const assessment = record(record(session.billing).assessment);
  return {
    disposed: final.disposed === true,
    session: {
      ...pick(session, ["extensionId", "name", "packageVersion", "installedVersion", "artifactSha256", "sessionId", "ownerRunId", "scenario", "startedAt", "closedAt", "applicationCleanup", "billingCleanup"]),
      sessions: (Array.isArray(session.sessions) ? session.sessions : []).map(entry => ({
        ...pick(entry, ["id", "state", "startedAt"]),
        cleanup: pick(record(entry).cleanup, ["applicationStopObserved", "stopClickedAt", "confirmClickedAt", "stoppedAt"]),
      })),
      productResult: { ...pick(session.productResult, ["confirmed", "observedAt", "question", "answer"]),
        ...(record(session.productResult).practice ? { practice: pick(record(session.productResult).practice, ["confirmed", "observedAt", "answer"]) } : {}),
      },
      billing: { assessment: {
        ...pick(assessment, ["status", "cleanupConfirmed", "expectedMinutes", "observedMinutes", "twoMinuteSteps", "cessationMs"]),
        sessions: (Array.isArray(assessment.sessions) ? assessment.sessions : []).map(row => pick(row, ["kind", "dateUtc", "durationSeconds"])),
      } },
    },
  };
}
