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
    // Why the cleanup did not finish, alongside the fact that it didn't. Run
    // #195 lost its executor to a container rollout and recorded "Executor was
    // no longer running" durably — and then dropped it here, leaving an
    // artifact that says only `disposed: false` about a phase we do understand.
    // Same four constants the cleanup writes; none of them is account data.
    ...(typeof final.cleanupFailure === "string" ? { cleanupFailure: final.cleanupFailure } : {}),
    session: {
      ...pick(session, ["extensionId", "name", "packageVersion", "installedVersion", "artifactSha256", "sessionId", "ownerRunId", "scenario", "startedAt", "closedAt", "applicationCleanup", "billingCleanup"]),
      sessions: (Array.isArray(session.sessions) ? session.sessions : []).map(entry => ({
        ...pick(entry, ["id", "state", "startedAt"]),
        cleanup: pick(record(entry).cleanup, ["applicationStopObserved", "stopClickedAt", "confirmClickedAt", "stoppedAt"]),
      })),
      productResult: { ...pick(session.productResult, ["confirmed", "observedAt", "question", "answer"]),
        ...(record(session.productResult).failure ? { failure: pick(record(session.productResult).failure, ["source", "text", "observedAt", "surface"]) } : {}),
        ...(record(session.productResult).practice ? { practice: pick(record(session.productResult).practice, ["confirmed", "observedAt", "answer"]) } : {}),
      },
      // `reason` is kept: it is the only field that says which of the eleven
      // checks refused, and without it a paid run that could not be confirmed
      // records the same silent "inconclusive" whatever went wrong (CHE-250 —
      // run #194 stopped two sessions and left no way to tell why its billing
      // was unverified). Every reason is a constant written here, never a
      // balance, a history row or anything else from the account.
      billing: { assessment: {
        ...pick(assessment, ["status", "cleanupConfirmed", "reason", "expectedMinutes", "observedMinutes", "twoMinuteSteps", "cessationMs"]),
        sessions: (Array.isArray(assessment.sessions) ? assessment.sessions : []).map(row => pick(row, ["kind", "dateUtc", "durationSeconds"])),
      } },
    },
  };
}
