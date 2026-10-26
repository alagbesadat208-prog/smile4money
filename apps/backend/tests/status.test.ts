/**
 * Public status page data (#115): component availability from live signals,
 * operator-posted incidents, and no signer details in the output.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { CircuitState } from '../src/services/circuit-breaker.js';
import {
  buildStatus,
  parseIncidents,
  publicText,
  type Incident,
} from '../src/services/status-service.js';
import statusRouter from '../src/routes/status.js';

const NOW = new Date('2026-10-22T12:00:00Z');

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'Lichess API unavailable',
    stage: 'investigating',
    impact: 'outage',
    components: ['lichess'],
    startedAt: '2026-10-22T11:00:00.000Z',
    updates: [],
    ...overrides,
  };
}

const status = (overrides: Partial<Parameters<typeof buildStatus>[0]> = {}) =>
  buildStatus({
    rpcCircuit: CircuitState.CLOSED,
    pendingSubmissions: 0,
    incidents: [],
    now: NOW,
    ...overrides,
  });

const component = (s: ReturnType<typeof buildStatus>, id: string) =>
  s.components.find((c) => c.id === id)!;

describe('component availability', () => {
  it('is all operational when every signal is healthy', () => {
    const s = status();
    expect(s.overall).toBe('operational');
    expect(s.components.map((c) => c.id)).toEqual([
      'stellar_rpc',
      'oracle_submissions',
      'lichess',
      'chessdotcom',
    ]);
  });

  it('maps the RPC circuit breaker to availability', () => {
    expect(component(status({ rpcCircuit: CircuitState.OPEN }), 'stellar_rpc').status).toBe(
      'outage',
    );
    expect(component(status({ rpcCircuit: CircuitState.HALF_OPEN }), 'stellar_rpc').status).toBe(
      'degraded',
    );
    expect(component(status({ rpcCircuit: null }), 'stellar_rpc').status).toBe('unknown');
  });

  it('reports waiting results as degraded submission, not a failed wager', () => {
    const c = component(status({ pendingSubmissions: 3 }), 'oracle_submissions');
    expect(c.status).toBe('degraded');
    expect(c.detail).toMatch(/3 result\(s\) waiting.*Funds stay in escrow/);
    expect(component(status({ pendingSubmissions: null }), 'oracle_submissions').status).toBe(
      'unknown',
    );
  });

  it('applies active incidents to their components and to the overall status', () => {
    const s = status({ incidents: [incident()] });
    expect(component(s, 'lichess')).toMatchObject({
      status: 'outage',
      detail: 'Lichess API unavailable',
    });
    expect(component(s, 'chessdotcom').status).toBe('operational');
    expect(s.overall).toBe('outage');
    expect(s.activeIncidents).toHaveLength(1);
  });

  it('lists resolved incidents for a week without affecting availability', () => {
    const resolved = incident({ stage: 'resolved', resolvedAt: '2026-10-21T00:00:00.000Z' });
    const old = incident({ id: 'old', stage: 'resolved', resolvedAt: '2026-10-01T00:00:00.000Z' });
    const s = status({ incidents: [resolved, old] });
    expect(component(s, 'lichess').status).toBe('operational');
    expect(s.recentIncidents.map((i) => i.id)).toEqual(['inc-1']);
  });
});

describe('incidents and redaction', () => {
  it('drops malformed incidents and unknown components', () => {
    const parsed = parseIncidents({
      incidents: [
        {
          id: 'ok',
          title: 'RPC slow',
          stage: 'monitoring',
          impact: 'degraded',
          components: ['stellar_rpc', 'mystery'],
          startedAt: '2026-10-22T10:00:00Z',
          updates: [{ at: '2026-10-22T10:05:00Z', message: 'Watching' }],
        },
        {
          id: 'bad-stage',
          stage: 'panicking',
          components: ['lichess'],
          startedAt: '2026-10-22T10:00:00Z',
        },
        {
          id: 'no-component',
          stage: 'investigating',
          components: ['mystery'],
          startedAt: '2026-10-22T10:00:00Z',
        },
        { id: 'no-date', stage: 'investigating', components: ['lichess'] },
        'garbage',
      ],
    });
    expect(parsed.map((i) => i.id)).toEqual(['ok']);
    expect(parsed[0].components).toEqual(['stellar_rpc']);
    expect(parsed[0].updates[0].message).toBe('Watching');
    expect(parseIncidents(null)).toEqual([]);
  });

  it('never publishes signer keys, even if an operator pastes one', () => {
    const signer = Keypair.random();
    const text = `Oracle ${signer.publicKey()} rotated; old secret ${signer.secret()}`;
    expect(publicText(text)).toBe('Oracle [redacted] rotated; old secret [redacted]');

    const [parsed] = parseIncidents({
      incidents: [
        {
          id: 'k',
          title: text,
          stage: 'identified',
          impact: 'degraded',
          components: ['oracle_submissions'],
          startedAt: '2026-10-22T10:00:00Z',
          updates: [{ at: '2026-10-22T10:01:00Z', message: text }],
        },
      ],
    });
    const published = JSON.stringify(status({ incidents: [parsed] }));
    expect(published).not.toContain(signer.publicKey());
    expect(published).not.toContain(signer.secret());
  });

  it('caps text length', () => {
    expect(publicText('x'.repeat(2000))).toHaveLength(500);
  });
});

describe('GET /status', () => {
  const app = express().use('/status', statusRouter);
  let tmp: string | null = null;

  afterEach(() => {
    delete process.env.STATUS_INCIDENTS_FILE;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('is public, cacheable and degrades unreadable signals to unknown', async () => {
    process.env.STATUS_INCIDENTS_FILE = path.join(os.tmpdir(), 'does-not-exist.json');
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(res.body.components).toHaveLength(4);
    // The queue isn't initialized in this test, so submission status is unknown.
    expect(
      res.body.components.find((c: { id: string }) => c.id === 'oracle_submissions').status,
    ).toBe('unknown');
  });

  it('publishes incidents from the configured file', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const file = path.join(tmp, 'incidents.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ incidents: [incident({ startedAt: new Date().toISOString() })] }),
    );
    process.env.STATUS_INCIDENTS_FILE = file;
    const res = await request(app).get('/status');
    expect(res.body.activeIncidents[0].title).toBe('Lichess API unavailable');
    expect(res.body.overall).toBe('outage');
  });
});
