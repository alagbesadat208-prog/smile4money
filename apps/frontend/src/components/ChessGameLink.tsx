import React from 'react';
import { sanitizeChessGameUrl, type ChessPlatform } from '../utils/chess-url';

export interface ChessGameLinkProps {
  url?: string | null;
  platform?: ChessPlatform;
  gameId?: string;
  className?: string;
  fallbackText?: string;
  children?: React.ReactNode;
}

/**
 * Safely renders a link to an external chess game.
 * If the URL fails security validation or is empty, it renders non-clickable fallback text
 * instead of an unsafe `<a>` tag.
 */
export function ChessGameLink({
  url,
  platform,
  gameId,
  className = 'text-blue-600 underline hover:text-blue-800 dark:text-blue-400',
  fallbackText,
  children,
}: ChessGameLinkProps) {
  const safeUrl = sanitizeChessGameUrl(url, platform);
  const displayText = children ?? (gameId ? `View game ${gameId}` : 'View game');

  if (!safeUrl) {
    if (fallbackText !== undefined) {
      return (
        <span className="safe-game-fallback" data-testid="unsafe-game-fallback">
          {fallbackText}
        </span>
      );
    }
    return null;
  }

  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      data-testid="chess-game-link"
    >
      {displayText}
    </a>
  );
}
