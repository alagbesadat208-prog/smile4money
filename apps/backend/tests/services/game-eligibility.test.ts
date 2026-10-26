/**
 * Game eligibility rules (#110): every machine-checkable rule in
 * docs/supported-games.md, with its rejection code and message.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_SPEEDS,
  UNSUPPORTED_SPEEDS,
  UNVERIFIABLE_END_STATUSES,
  checkGameEligibility,
  chessDotComMetadata,
  lichessMetadata,
} from '../../src/services/game-eligibility.js';

const STANDARD_BLITZ = { status: 'mate', variant: 'standard', speed: 'blitz', initialSeconds: 180 };

describe('checkGameEligibility', () => {
  it('accepts a finished standard real-time game', () => {
    expect(checkGameEligibility(STANDARD_BLITZ)).toEqual({ eligible: true, rejections: [] });
  });

  it('accepts a game that is still in progress', () => {
    expect(checkGameEligibility({ ...STANDARD_BLITZ, status: 'started' }).eligible).toBe(true);
  });

  it.each(SUPPORTED_SPEEDS)('accepts the %s time control', (speed) => {
    expect(checkGameEligibility({ ...STANDARD_BLITZ, speed }).eligible).toBe(true);
  });

  it.each(['chess960', 'fromPosition', 'crazyhouse', 'atomic', 'kingOfTheHill'])(
    'rejects the %s variant',
    (variant) => {
      const { eligible, rejections } = checkGameEligibility({ ...STANDARD_BLITZ, variant });
      expect(eligible).toBe(false);
      expect(rejections).toEqual([
        {
          code: 'UNSUPPORTED_VARIANT',
          message: `Variant "${variant}" is not supported; only standard chess can be wagered on.`,
        },
      ]);
    },
  );

  it.each(UNSUPPORTED_SPEEDS)('rejects the %s time control', (speed) => {
    const { rejections } = checkGameEligibility({ ...STANDARD_BLITZ, speed });
    expect(rejections.map((r) => r.code)).toEqual(['UNSUPPORTED_TIME_CONTROL']);
    expect(rejections[0].message).toContain(speed);
  });

  it('rejects a game without a clock', () => {
    const { rejections } = checkGameEligibility({ ...STANDARD_BLITZ, initialSeconds: null });
    expect(rejections).toEqual([
      {
        code: 'NO_CLOCK',
        message: 'Games without a clock are not supported; play with a time control.',
      },
    ]);
  });

  it.each(UNVERIFIABLE_END_STATUSES)('rejects a game that ended as %s', (status) => {
    const { rejections } = checkGameEligibility({ ...STANDARD_BLITZ, status });
    expect(rejections).toEqual([
      {
        code: 'UNVERIFIABLE_COMPLETION',
        message: `The game ended as "${status}", which has no verifiable result.`,
      },
    ]);
  });

  it.each([
    'mate',
    'resign',
    'stalemate',
    'timeout',
    'draw',
    'outoftime',
    'cheat',
    'variantEnd',
    'finished',
  ])('accepts the verifiable end status %s', (status) => {
    expect(checkGameEligibility({ ...STANDARD_BLITZ, status }).eligible).toBe(true);
  });

  it('reports every broken rule, in a fixed order', () => {
    const { rejections } = checkGameEligibility({
      status: 'aborted',
      variant: 'chess960',
      speed: 'correspondence',
      initialSeconds: null,
    });
    expect(rejections.map((r) => r.code)).toEqual([
      'UNSUPPORTED_VARIANT',
      'UNSUPPORTED_TIME_CONTROL',
      'NO_CLOCK',
      'UNVERIFIABLE_COMPLETION',
    ]);
  });

  it('only checks the fields it is given', () => {
    expect(checkGameEligibility({})).toEqual({ eligible: true, rejections: [] });
    expect(checkGameEligibility({ status: 'mate' }).eligible).toBe(true);
  });
});

describe('lichessMetadata', () => {
  it('reads variant, speed, status and clock from a game export', () => {
    expect(
      lichessMetadata({
        id: 'abcd1234',
        status: 'resign',
        variant: 'standard',
        speed: 'rapid',
        clock: { initial: 600, increment: 5, totalTime: 800 },
      }),
    ).toEqual({ status: 'resign', variant: 'standard', speed: 'rapid', initialSeconds: 600 });
  });

  it('marks correspondence and unlimited games as having no clock', () => {
    const meta = lichessMetadata({
      status: 'started',
      variant: 'standard',
      speed: 'correspondence',
    });
    expect(meta.initialSeconds).toBeNull();
    expect(checkGameEligibility(meta).rejections.map((r) => r.code)).toEqual([
      'UNSUPPORTED_TIME_CONTROL',
      'NO_CLOCK',
    ]);
  });

  it('rejects a custom starting position', () => {
    const meta = lichessMetadata({
      status: 'mate',
      variant: 'fromPosition',
      speed: 'blitz',
      clock: { initial: 180 },
    });
    expect(checkGameEligibility(meta).rejections.map((r) => r.code)).toEqual([
      'UNSUPPORTED_VARIANT',
    ]);
  });

  it('ignores malformed payloads', () => {
    expect(lichessMetadata(null)).toEqual({});
    expect(lichessMetadata({ variant: 7, clock: 'none' })).toEqual({});
  });
});

describe('chessDotComMetadata', () => {
  it('reads a live game', () => {
    expect(
      chessDotComMetadata({ rules: 'chess', time_class: 'blitz', time_control: '180+2' }),
    ).toEqual({ variant: 'standard', speed: 'blitz', initialSeconds: 180 });
  });

  it('rejects daily games, which have no game clock', () => {
    const meta = chessDotComMetadata({
      rules: 'chess',
      time_class: 'daily',
      time_control: '1/86400',
    });
    expect(meta).toEqual({ variant: 'standard', speed: 'daily', initialSeconds: null });
    expect(checkGameEligibility(meta).rejections.map((r) => r.code)).toEqual([
      'UNSUPPORTED_TIME_CONTROL',
      'NO_CLOCK',
    ]);
  });

  it('rejects Chess960', () => {
    const meta = chessDotComMetadata({
      rules: 'chess960',
      time_class: 'rapid',
      time_control: '600',
    });
    expect(checkGameEligibility(meta).rejections.map((r) => r.code)).toEqual([
      'UNSUPPORTED_VARIANT',
    ]);
  });

  it('ignores malformed payloads', () => {
    expect(chessDotComMetadata(undefined)).toEqual({});
  });
});
