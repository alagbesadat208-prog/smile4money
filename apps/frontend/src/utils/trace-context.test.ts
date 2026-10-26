import { describe, it, expect } from 'vitest';
import { createTraceparent, traceIdOf } from './trace-context';

describe('createTraceparent', () => {
  it('produces a valid, sampled W3C traceparent', () => {
    expect(createTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('never uses an all-zero trace or span id, and is unique per call', () => {
    const values = new Set(Array.from({ length: 50 }, createTraceparent));
    expect(values.size).toBe(50);
    for (const v of values) {
      expect(v).not.toContain('0'.repeat(32));
      expect(v.split('-')[2]).not.toBe('0'.repeat(16));
    }
  });
});

describe('traceIdOf', () => {
  it('extracts the trace id', () => {
    expect(traceIdOf('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it.each([null, undefined, '', 'nope', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'])(
    'returns null for %s',
    (value) => {
      expect(traceIdOf(value)).toBeNull();
    },
  );
});
