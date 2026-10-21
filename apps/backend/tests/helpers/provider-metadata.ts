import type { MatchResult } from '../../src/fetchers/lichess.js';
import type { Evidence } from '../../src/fetchers/result.js';

/** Minimal normalized metadata for tests that mock the provider boundary. */
export function providerMetadata(
  provider: Evidence['provider'] = 'lichess',
  outcome: MatchResult | null = 'Player1Wins',
) {
  const endedAt = outcome === null ? null : '2023-11-14T22:13:20.000Z';
  return {
    endedAt,
    evidence: {
      provider,
      fetchedAt: '2023-11-14T22:13:20.000Z',
      parserVersion: '2',
      responseHash: 'a'.repeat(64),
      source: `provider:${provider}`,
      outcome,
      endedAt,
    },
  };
}
