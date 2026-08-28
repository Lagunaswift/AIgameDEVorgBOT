// Scoring policy is deliberately bounded. These limits protect the anti-farm rules from
// accidental zero/NaN settings and keep legacy-counter derivation reasonably small.
export const SCORING_POLICY_BOUNDS = Object.freeze({
  minCommentLength: Object.freeze({ min: 1, max: 10_000 }),
  maxPointsPerThreadPerUser: Object.freeze({ min: 1, max: 1000 }),
});

export function assertScoringPolicy(policy, source = 'scoring policy') {
  for (const [field, bounds] of Object.entries(SCORING_POLICY_BOUNDS)) {
    const value = policy?.[field];
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(
        `${source}.${field} must be a finite integer between ${bounds.min} and ${bounds.max}; received ${String(value)}`,
      );
    }
  }
  return policy;
}
