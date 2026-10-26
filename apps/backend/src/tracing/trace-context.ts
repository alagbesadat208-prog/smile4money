/**
 * W3C Trace Context propagation (issue #123).
 *
 * Carries a `traceparent` / `tracestate` pair from an incoming HTTP request
 * through durable queue work (the oracle DLQ, polling jobs) and on to the
 * provider and Stellar RPC calls that work makes, so one trace id ties the
 * whole lifecycle of a match together, including retries hours later.
 *
 * Deliberately dependency-free: this is the propagation format only, not an
 * exporter. The trace and span ids land in every structured log line (see
 * logger.ts), and any OpenTelemetry collector that reads `traceparent`
 * headers can join the outbound calls to the same trace.
 *
 * What a trace may contain: random ids, sampling flags and a sanitised
 * `tracestate`. Never request bodies, wallet addresses, secret keys or
 * provider tokens; `sanitizeTraceState` enforces that for the one field a
 * client controls.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface TraceContext {
  /** 32 lowercase hex chars, never all zeros. */
  traceId: string;
  /** 16 lowercase hex chars for the current span, never all zeros. */
  spanId: string;
  /** Span this one continues from, when there is one. */
  parentSpanId?: string;
  /** 2 hex chars; bit 0 is "sampled". */
  flags: string;
  /** Sanitised vendor list, or undefined when empty. */
  traceState?: string;
}

/** The serialised form stored with queued work. */
export interface PersistedTraceContext {
  traceparent: string;
  tracestate?: string;
}

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

// tracestate limits from the spec: at most 32 list members, 512 chars total.
const MAX_TRACESTATE_MEMBERS = 32;
const MAX_TRACESTATE_LENGTH = 512;
const TRACESTATE_KEY_RE =
  /^(?:[a-z][a-z0-9_\-*/]{0,255}|[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13})$/;
const TRACESTATE_VALUE_RE =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/**
 * Values that must never ride along in a trace, whatever a client sends:
 * Stellar secret seeds (S + 55 base32 chars), JWT-shaped tokens, and
 * Lichess personal API tokens. Members whose key names a credential are
 * dropped too.
 */
const SECRET_VALUE_PATTERNS = [
  /S[A-Z2-7]{55}/,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/,
  /li[op]_[A-Za-z0-9]{8,}/,
];
const SECRET_KEY_RE =
  /(secret|token|password|passwd|auth|api[_-]?key|private|seed|session|cookie|bearer)/i;

const storage = new AsyncLocalStorage<TraceContext>();

function randomHex(bytes: number, zero: string): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    if (hex !== zero) return hex;
  }
}

/** Parse a `traceparent` header. Returns null for anything the spec says to ignore. */
export function parseTraceparent(
  header: string | undefined | null,
): Omit<TraceContext, "parentSpanId"> | null {
  if (typeof header !== "string") return null;
  const match = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match;
  // Version ff is forbidden; unknown future versions are read as 00 per spec,
  // which this strict 4-field regex already limits to.
  if (version === "ff" || traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID)
    return null;
  return { traceId, spanId, flags };
}

export function formatTraceparent(
  ctx: Pick<TraceContext, "traceId" | "spanId" | "flags">,
): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}

/**
 * Keep only well-formed `tracestate` members that carry no credentials.
 * Returns undefined when nothing survives.
 */
export function sanitizeTraceState(
  header: string | undefined | null,
): string | undefined {
  if (typeof header !== "string" || header.length === 0) return undefined;
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of header.split(",")) {
    const member = raw.trim();
    if (!member) continue;
    const eq = member.indexOf("=");
    if (eq <= 0) continue;
    const key = member.slice(0, eq);
    const value = member.slice(eq + 1);
    if (!TRACESTATE_KEY_RE.test(key) || !TRACESTATE_VALUE_RE.test(value))
      continue;
    if (
      SECRET_KEY_RE.test(key) ||
      SECRET_VALUE_PATTERNS.some((re) => re.test(value))
    )
      continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(`${key}=${value}`);
    if (kept.length === MAX_TRACESTATE_MEMBERS) break;
  }
  let joined = kept.join(",");
  while (joined.length > MAX_TRACESTATE_LENGTH && kept.length > 0) {
    kept.pop();
    joined = kept.join(",");
  }
  return joined || undefined;
}

/** Start a brand-new trace (sampled). */
export function newTraceContext(): TraceContext {
  return {
    traceId: randomHex(16, ZERO_TRACE_ID),
    spanId: randomHex(8, ZERO_SPAN_ID),
    flags: "01",
  };
}

/** A new span in the same trace, parented on `parent`. */
export function childContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomHex(8, ZERO_SPAN_ID),
    parentSpanId: parent.spanId,
    flags: parent.flags,
    traceState: parent.traceState,
  };
}

/**
 * Continue the trace described by incoming headers, or start one when they
 * are missing or invalid. The returned context is a fresh span whose parent
 * is the caller's span.
 */
export function contextFromHeaders(
  traceparent: string | undefined | null,
  tracestate: string | undefined | null,
): TraceContext {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return newTraceContext();
  // tracestate is only meaningful alongside a valid traceparent.
  return childContext({
    ...parsed,
    traceState: sanitizeTraceState(tracestate),
  });
}

/** The active context, if code is running inside one. */
export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `ctx` as the active trace context. */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Serialise the active (or given) context for storage with queued work. */
export function persistTraceContext(
  ctx: TraceContext | undefined = currentTraceContext(),
): PersistedTraceContext | undefined {
  if (!ctx) return undefined;
  const persisted: PersistedTraceContext = {
    traceparent: formatTraceparent(ctx),
  };
  const state = sanitizeTraceState(ctx.traceState);
  if (state) persisted.tracestate = state;
  return persisted;
}

/**
 * Resume persisted work as a child span of the context it was queued under.
 * Each call (each retry) gets its own span id under the original trace id.
 * Falls back to a new trace for work queued before this existed or with a
 * corrupted value, so a bad row never blocks processing.
 */
export function resumeTraceContext(
  persisted: PersistedTraceContext | undefined | null,
): TraceContext {
  if (!persisted || typeof persisted !== "object") return newTraceContext();
  return contextFromHeaders(persisted.traceparent, persisted.tracestate);
}

/** Headers to send on an outbound request from inside the active context. */
export function traceHeaders(
  ctx: TraceContext | undefined = currentTraceContext(),
): Record<string, string> {
  if (!ctx) return {};
  const headers: Record<string, string> = {
    traceparent: formatTraceparent(ctx),
  };
  const state = sanitizeTraceState(ctx.traceState);
  if (state) headers.tracestate = state;
  return headers;
}

/** Fields merged into every log line written inside a context. */
export function traceLogFields(
  ctx: TraceContext | undefined = currentTraceContext(),
): Record<string, string> {
  if (!ctx) return {};
  const fields: Record<string, string> = {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
  };
  if (ctx.parentSpanId) fields.parent_span_id = ctx.parentSpanId;
  return fields;
}
