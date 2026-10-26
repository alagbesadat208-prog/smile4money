import axios from 'axios';
import logger from '../logger.js';

export type ProviderFailureKind =
  | 'unavailable'
  | 'invalid_data'
  | 'access_denied';
export class ProviderFetchError extends Error {
  readonly policy: 'retry' | 'review';
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderFetchError';
    this.policy = kind === 'unavailable' ? 'retry' : 'review';
  }
}

/** Never include payloads, player names, URLs, tokens or unknown provider labels. */
export function quarantine(provider: string, reason: string): never {
  logger.warn({ provider, reason }, 'provider_evidence_quarantined');
  throw new ProviderFetchError(
    'invalid_data',
    `${provider}: ${reason}; operator review required`,
  );
}

export async function providerGet(
  url: string,
  options: Parameters<typeof axios.get>[1],
) {
  try {
    return await axios.get(url, options);
  } catch {
    // Axios errors can contain authorization headers and raw response bodies.
    throw new ProviderFetchError(
      'unavailable',
      'Provider unavailable; retry later',
    );
  }
}

export function checkHttpStatus(provider: string, status: number): void {
  if (status >= 500 || status === 408) {
    throw new ProviderFetchError(
      'unavailable',
      `${provider} API error: ${status}`,
    );
  }
  if (status !== 200) {
    throw new ProviderFetchError(
      'access_denied',
      `${provider} API rejected request: ${status}; operator review required`,
    );
  }
}

export const CLOCK_SKEW_MS = 60_000;
export const MAX_LIVE_DURATION_MS = 24 * 60 * 60 * 1_000;
// Correspondence games can span years. This is a conservative evidence ceiling,
// not a time-control calculation (increments and vacations extend wall time).
export const MAX_CORRESPONDENCE_DURATION_MS = 10 * 366 * MAX_LIVE_DURATION_MS;

export function validateChronology(
  provider: string,
  start: unknown,
  end: unknown,
  correspondence = false,
): void {
  const maxDuration = correspondence
    ? MAX_CORRESPONDENCE_DURATION_MS
    : MAX_LIVE_DURATION_MS;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    end <= 0 ||
    end < start ||
    end > Date.now() + CLOCK_SKEW_MS ||
    end - start > maxDuration
  ) {
    quarantine(provider, 'invalid_chronology');
  }
}
