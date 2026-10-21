import { describe, expect, it } from 'vitest';
import { publicEnv } from './public-env';

describe('public environment schema', () => {
  it('exposes only public browser configuration', () => {
    expect(publicEnv).toEqual({
      stellarNetwork: expect.any(String),
      stellarRpcUrl: expect.any(String),
      leaderboardContractId: expect.any(String),
    });
    expect(Object.keys(publicEnv)).toEqual([
      'stellarNetwork',
      'stellarRpcUrl',
      'leaderboardContractId',
    ]);
  });
});
