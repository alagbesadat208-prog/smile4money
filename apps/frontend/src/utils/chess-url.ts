/**
 * Chess Platform URL validation utilities.
 * Single source of truth for external chess platform links (Lichess and Chess.com).
 */

export type ChessPlatform = 'lichess' | 'chesscom';

/** Exact allowed hosts for each supported platform. */
export const SUPPORTED_CHESS_HOSTS: Record<ChessPlatform, readonly string[]> = {
  lichess: ['lichess.org', 'www.lichess.org'],
  chesscom: ['chess.com', 'www.chess.com'],
};

const ALL_ALLOWED_HOSTS = new Set<string>([
  ...SUPPORTED_CHESS_HOSTS.lichess,
  ...SUPPORTED_CHESS_HOSTS.chesscom,
]);

/**
 * Validates whether a URL is a safe, valid HTTPS link to a supported chess platform.
 *
 * Rules:
 * - Must be a valid parseable URL.
 * - Scheme must be strictly HTTPS.
 * - Hostname must match the exact allowed hostnames for the platform (or any supported platform if unspecified).
 *   Subdomain suffix tricks (e.g., `lichess.org.attacker.com`) and prefix tricks (`evillichess.org`) are rejected.
 * - Credentials (username/password) in the URL are rejected.
 * - Non-standard ports (anything other than 443 or default empty) are rejected.
 */
export function isValidChessGameUrl(
  urlString: string | null | undefined,
  platform?: ChessPlatform,
): boolean {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  const trimmed = urlString.trim();
  if (!trimmed) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  // Strict HTTPS requirement
  if (parsed.protocol !== 'https:') {
    return false;
  }

  // Reject credentials in URL
  if (parsed.username || parsed.password) {
    return false;
  }

  // Reject non-standard ports
  if (parsed.port && parsed.port !== '443') {
    return false;
  }

  // Normalize hostname to lower-case
  const hostname = parsed.hostname.toLowerCase();

  if (platform) {
    const allowed = SUPPORTED_CHESS_HOSTS[platform];
    if (!allowed || !allowed.includes(hostname)) {
      return false;
    }
  } else {
    if (!ALL_ALLOWED_HOSTS.has(hostname)) {
      return false;
    }
  }

  return true;
}

/**
 * Sanitizes and returns a safe URL string if valid, or null if invalid or unsafe.
 */
export function sanitizeChessGameUrl(
  urlString: string | null | undefined,
  platform?: ChessPlatform,
): string | null {
  if (!isValidChessGameUrl(urlString, platform)) {
    return null;
  }
  try {
    return new URL(urlString!.trim()).href;
  } catch {
    return null;
  }
}

/**
 * Builds the canonical official URL for a game on the specified platform.
 */
export function buildChessGameUrl(platform: ChessPlatform, gameId: string): string {
  const sanitizedId = encodeURIComponent(gameId.trim());
  if (platform === 'lichess') {
    return `https://lichess.org/${sanitizedId}`;
  }
  return `https://www.chess.com/game/live/${sanitizedId}`;
}
