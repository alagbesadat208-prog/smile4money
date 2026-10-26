/**
 * W3C trace context for calls to the smile4money backend (issue #123).
 *
 * Each backend request starts a new trace by sending a `traceparent` header.
 * The backend continues it through queued oracle work and retries, and echoes
 * its own span back in the response's `traceparent`, which is what a user
 * quotes to support when a match settles late or not at all.
 *
 * Only sent to our own API: Horizon and other third parties never get it.
 * The header carries random ids only, never wallet or session data.
 */

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf.some((b) => b !== 0)) {
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
}

/** A fresh, sampled `traceparent` value: `00-<trace id>-<span id>-01`. */
export function createTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** The trace id inside a `traceparent` value, or null when it is not one. */
export function traceIdOf(traceparent: string | null | undefined): string | null {
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent ?? '');
  return match ? match[1] : null;
}
