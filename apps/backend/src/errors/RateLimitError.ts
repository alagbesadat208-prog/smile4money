/**
 * RateLimitError is thrown when an API call hits a rate limit (429).
 * Callers should catch this error specifically and retry with backoff,
 * rather than treating it as a permanent failure.
 */
export class RateLimitError extends Error {
  readonly policy = 'retry' as const;
  constructor(
    message: string = 'Rate limit exceeded',
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }

  /**
   * Check if an error is a RateLimitError.
   * Useful for instanceof checks in catch blocks.
   */
  static isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }
}
