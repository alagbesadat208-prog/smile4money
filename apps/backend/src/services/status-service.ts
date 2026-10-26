/**
 * Public service status (#115).
 *
 * One place where participants can tell a service outage from a failed
 * wager: component-level availability plus the incidents operators post.
 * Served by `GET /status` (routes/status.ts); the procedure for posting and
 * updating incidents is in docs/status-page.md.
 *
 * Nothing here exposes signer details. Output is built from an allowlist of
 * fields, never from raw errors or configuration, and any text that looks
 * like a Stellar key (G…/S…/C… StrKey) is redacted before it is published.
 */
import fs from 'fs';
import { CircuitState } from './circuit-breaker.js';

export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'unknown';
export type IncidentStage = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export const COMPONENTS = {
  stellar_rpc: 'Stellar network (Soroban RPC)',
  oracle_submissions: 'Result submission (oracle)',
  lichess: 'Lichess game data',
  chessdotcom: 'Chess.com game data',
} as const;

export type ComponentId = keyof typeof COMPONENTS;

export interface IncidentUpdate {
  at: string;
  message: string;
}

export interface Incident {
  id: string;
  title: string;
  stage: IncidentStage;
  impact: 'degraded' | 'outage';
  components: ComponentId[];
  startedAt: string;
  resolvedAt?: string;
  updates: IncidentUpdate[];
}

export interface StatusSignals {
  /** State of the RPC circuit breaker, or null when unknown. */
  rpcCircuit: CircuitState | null;
  /** Results waiting in the retry queue, or null when it can't be read. */
  pendingSubmissions: number | null;
  incidents: Incident[];
  now: Date;
}

export interface PublicComponent {
  id: ComponentId;
  name: string;
  status: ComponentStatus;
  detail: string;
}

export interface PublicStatus {
  updatedAt: string;
  overall: ComponentStatus;
  components: PublicComponent[];
  activeIncidents: Incident[];
  recentIncidents: Incident[];
}

/** Results waiting longer than this count makes submission "degraded". */
export const PENDING_DEGRADED_THRESHOLD = 1;
/** Resolved incidents stay listed for this long. */
export const RECENT_INCIDENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_TEXT = 500;
const STAGES: IncidentStage[] = ['investigating', 'identified', 'monitoring', 'resolved'];
// A Stellar StrKey: version letter + 55 base32 characters (68 for muxed M… addresses).
const STRKEY = /\b[GSCMT][A-Z2-7]{55}(?:[A-Z2-7]{13})?\b/g;

/** Text safe to publish: trimmed, length-capped, Stellar keys redacted. */
export function publicText(value: unknown): string {
  return String(value ?? '')
    .replace(STRKEY, '[redacted]')
    .trim()
    .slice(0, MAX_TEXT);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Parse and sanitize operator-written incidents; malformed entries are dropped. */
export function parseIncidents(raw: unknown): Incident[] {
  const list = Array.isArray((raw as { incidents?: unknown })?.incidents)
    ? (raw as { incidents: unknown[] }).incidents
    : [];
  const out: Incident[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const i = item as Record<string, unknown>;
    const startedAt = isoOrNull(i.startedAt);
    const stage = STAGES.includes(i.stage as IncidentStage) ? (i.stage as IncidentStage) : null;
    const components = Array.isArray(i.components)
      ? (i.components.filter((c) => typeof c === 'string' && c in COMPONENTS) as ComponentId[])
      : [];
    if (!startedAt || !stage || components.length === 0 || typeof i.id !== 'string') continue;
    const updates = Array.isArray(i.updates)
      ? i.updates
          .map((u) => {
            const at = isoOrNull((u as Record<string, unknown>)?.at);
            return at ? { at, message: publicText((u as Record<string, unknown>).message) } : null;
          })
          .filter((u): u is IncidentUpdate => u !== null)
          .sort((a, b) => b.at.localeCompare(a.at))
      : [];
    const resolvedAt = isoOrNull(i.resolvedAt) ?? undefined;
    out.push({
      id: publicText(i.id).slice(0, 64),
      title: publicText(i.title),
      stage,
      impact: i.impact === 'outage' ? 'outage' : 'degraded',
      components,
      startedAt,
      ...(resolvedAt ? { resolvedAt } : {}),
      updates,
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Read incidents from `file`; a missing or unreadable file means none. */
export function loadIncidents(file: string): Incident[] {
  try {
    return parseIncidents(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

const RANK: Record<ComponentStatus, number> = {
  operational: 0,
  unknown: 1,
  degraded: 2,
  outage: 3,
};
const worst = (a: ComponentStatus, b: ComponentStatus) => (RANK[b] > RANK[a] ? b : a);

/** Build the public status document from live signals and posted incidents. */
export function buildStatus(signals: StatusSignals): PublicStatus {
  const nowMs = signals.now.getTime();
  const active = signals.incidents.filter((i) => i.stage !== 'resolved');
  const recent = signals.incidents.filter(
    (i) =>
      i.stage === 'resolved' &&
      nowMs - Date.parse(i.resolvedAt ?? i.startedAt) <= RECENT_INCIDENT_WINDOW_MS,
  );

  const measured: Record<ComponentId, { status: ComponentStatus; detail: string }> = {
    stellar_rpc:
      signals.rpcCircuit === null
        ? { status: 'unknown', detail: 'No recent measurement.' }
        : signals.rpcCircuit === CircuitState.OPEN
          ? {
              status: 'outage',
              detail: 'Requests to the Stellar network are failing; retries are paused.',
            }
          : signals.rpcCircuit === CircuitState.HALF_OPEN
            ? {
                status: 'degraded',
                detail: 'Recovering from failed requests to the Stellar network.',
              }
            : { status: 'operational', detail: 'Requests to the Stellar network are succeeding.' },
    oracle_submissions:
      signals.pendingSubmissions === null
        ? { status: 'unknown', detail: 'Submission queue could not be read.' }
        : signals.pendingSubmissions >= PENDING_DEGRADED_THRESHOLD
          ? {
              status: 'degraded',
              detail: `${signals.pendingSubmissions} result(s) waiting to be submitted. Funds stay in escrow until they settle.`,
            }
          : { status: 'operational', detail: 'No results waiting.' },
    lichess: { status: 'operational', detail: 'No known issues.' },
    chessdotcom: { status: 'operational', detail: 'No known issues.' },
  };

  const components = (Object.keys(COMPONENTS) as ComponentId[]).map((id) => {
    let { status, detail } = measured[id];
    for (const incident of active) {
      if (!incident.components.includes(id)) continue;
      status = worst(status, incident.impact);
      detail = incident.title || detail;
    }
    return { id, name: COMPONENTS[id], status, detail };
  });

  return {
    updatedAt: signals.now.toISOString(),
    overall: components.reduce<ComponentStatus>((acc, c) => worst(acc, c.status), 'operational'),
    components,
    activeIncidents: active,
    recentIncidents: recent,
  };
}
