/**
 * ProviderSchemaError is thrown when a chess provider returns a payload the
 * parser does not recognise: a missing field, a wrong type, or a result code
 * outside the known set.
 *
 * This is deliberately not mapped to any MatchResult. A provider changing its
 * schema must stop settlement and surface as a failed poll, never silently
 * settle a wager as a draw or a win (issue #121).
 */
export class ProviderSchemaError extends Error {
  constructor(
    public readonly provider: "lichess" | "chessdotcom",
    message: string,
  ) {
    super(`${provider} response schema not recognised: ${message}`);
    this.name = "ProviderSchemaError";
    Object.setPrototypeOf(this, ProviderSchemaError.prototype);
  }
}
