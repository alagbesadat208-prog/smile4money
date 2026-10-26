import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  isValidChessGameUrl,
  sanitizeChessGameUrl,
  buildChessGameUrl,
  SUPPORTED_CHESS_HOSTS,
} from '../src/utils/chess-url';
import { ChessGameLink } from '../src/components/ChessGameLink';
import { MatchStatus } from '../src/components/MatchStatus';

describe('Issue #1951 — Chess Platform External URL Handling', () => {
  describe('isValidChessGameUrl & sanitizeChessGameUrl', () => {
    it('accepts valid HTTPS URLs for supported platforms', () => {
      // Lichess
      expect(isValidChessGameUrl('https://lichess.org/abc12345')).toBe(true);
      expect(isValidChessGameUrl('https://www.lichess.org/abc12345')).toBe(true);
      expect(isValidChessGameUrl('https://lichess.org/abc12345/white', 'lichess')).toBe(true);

      // Chess.com
      expect(isValidChessGameUrl('https://www.chess.com/game/live/123456789')).toBe(true);
      expect(isValidChessGameUrl('https://chess.com/game/live/123456789', 'chesscom')).toBe(true);

      expect(sanitizeChessGameUrl('https://lichess.org/abc12345')).toBe(
        'https://lichess.org/abc12345',
      );
    });

    it('rejects javascript: and other dangerous scripting protocols', () => {
      expect(isValidChessGameUrl('javascript:alert(1)')).toBe(false);
      expect(isValidChessGameUrl('JAVASCRIPT:alert(document.cookie)')).toBe(false);
      expect(sanitizeChessGameUrl('javascript:alert(1)')).toBeNull();
    });

    it('rejects data:, file:, ftp:, and plain http schemes', () => {
      expect(isValidChessGameUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
      expect(isValidChessGameUrl('file:///etc/passwd')).toBe(false);
      expect(isValidChessGameUrl('ftp://lichess.org/game')).toBe(false);
      expect(isValidChessGameUrl('http://lichess.org/abc12345')).toBe(false); // HTTP not allowed
      expect(isValidChessGameUrl('http://www.chess.com/game/live/123')).toBe(false);
    });

    it('rejects lookalike, spoofed, and deceptive hostnames', () => {
      // Subdomain suffix attacks
      expect(isValidChessGameUrl('https://lichess.org.attacker.com/game')).toBe(false);
      expect(isValidChessGameUrl('https://chess.com.phishing.io/live')).toBe(false);

      // Prefix tricks
      expect(isValidChessGameUrl('https://evillichess.org/game')).toBe(false);
      expect(isValidChessGameUrl('https://fake-chess.com/game')).toBe(false);

      // Unrelated domain
      expect(isValidChessGameUrl('https://example.com/game')).toBe(false);
      expect(isValidChessGameUrl('https://google.com')).toBe(false);

      // Subdomain of lichess.org not in allowlist
      expect(isValidChessGameUrl('https://malicious.sub.lichess.org/game')).toBe(false);
    });

    it('rejects URLs with embedded credentials or non-standard ports', () => {
      expect(isValidChessGameUrl('https://user:pass@lichess.org/game')).toBe(false);
      expect(isValidChessGameUrl('https://attacker@chess.com/game')).toBe(false);
      expect(isValidChessGameUrl('https://lichess.org:8080/game')).toBe(false);
      expect(isValidChessGameUrl('https://lichess.org:443/game')).toBe(true); // standard HTTPS port allowed
    });

    it('handles malformed, null, undefined, and empty URLs without crashing', () => {
      expect(isValidChessGameUrl(null)).toBe(false);
      expect(isValidChessGameUrl(undefined)).toBe(false);
      expect(isValidChessGameUrl('')).toBe(false);
      expect(isValidChessGameUrl('   ')).toBe(false);
      expect(isValidChessGameUrl('ht tp://bad url')).toBe(false);
      expect(isValidChessGameUrl('///not-a-url')).toBe(false);
      expect(sanitizeChessGameUrl('///not-a-url')).toBeNull();
    });

    it('rejects when platform is specified and URL belongs to a different platform', () => {
      // Chess.com url passed for lichess platform
      expect(
        isValidChessGameUrl('https://www.chess.com/game/live/123', 'lichess'),
      ).toBe(false);

      // Lichess url passed for chesscom platform
      expect(isValidChessGameUrl('https://lichess.org/abc123', 'chesscom')).toBe(
        false,
      );
    });

    it('buildChessGameUrl builds valid canonical URLs', () => {
      const lichessUrl = buildChessGameUrl('lichess', 'abc123');
      expect(lichessUrl).toBe('https://lichess.org/abc123');
      expect(isValidChessGameUrl(lichessUrl)).toBe(true);

      const chesscomUrl = buildChessGameUrl('chesscom', '987654');
      expect(chesscomUrl).toBe('https://www.chess.com/game/live/987654');
      expect(isValidChessGameUrl(chesscomUrl)).toBe(true);
    });
  });

  describe('ChessGameLink Component', () => {
    it('renders a safe new-tab link with rel="noopener noreferrer" for valid URLs', () => {
      render(
        <ChessGameLink url="https://lichess.org/game123" platform="lichess">
          View on Lichess
        </ChessGameLink>,
      );

      const link = screen.getByRole('link', { name: /View on Lichess/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', 'https://lichess.org/game123');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does NOT render a clickable link for invalid or dangerous URLs', () => {
      render(
        <ChessGameLink
          url="javascript:alert(1)"
          platform="lichess"
          fallbackText="Invalid game link"
        >
          Dangerous Link
        </ChessGameLink>,
      );

      // No link should be in the document
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByTestId('unsafe-game-fallback')).toHaveTextContent(
        'Invalid game link',
      );
    });

    it('does NOT render a clickable link for lookalike attacker domains', () => {
      render(
        <ChessGameLink
          url="https://lichess.org.attacker.com/game123"
          platform="lichess"
          fallbackText="Safe fallback"
        />,
      );

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByTestId('unsafe-game-fallback')).toHaveTextContent(
        'Safe fallback',
      );
    });

    it('handles malformed URL without throwing during render', () => {
      expect(() => {
        render(
          <ChessGameLink
            url="not a valid url at all :///"
            platform="lichess"
            fallbackText="Fallback on error"
          />,
        );
      }).not.toThrow();

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByTestId('unsafe-game-fallback')).toHaveTextContent(
        'Fallback on error',
      );
    });
  });

  describe('MatchStatus integration with external game links', () => {
    it('renders validated clickable link when matchData includes a valid gameUrl', async () => {
      const onFetchMatch = vi.fn().mockResolvedValue({
        id: '99',
        state: 'Active',
        player1: 'GPLAYER1',
        player2: 'GPLAYER2',
        stakeAmount: '100',
        token: 'xlm',
        platform: 'lichess',
        gameId: 'game99',
        gameUrl: 'https://lichess.org/game99',
      });

      render(<MatchStatus matchId="99" onFetchMatch={onFetchMatch} />);

      await waitFor(() => {
        expect(screen.getByTestId('chess-game-link')).toBeInTheDocument();
      });

      const link = screen.getByTestId('chess-game-link');
      expect(link).toHaveAttribute('href', 'https://lichess.org/game99');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does not render a clickable link when matchData provides an invalid gameUrl', async () => {
      const onFetchMatch = vi.fn().mockResolvedValue({
        id: '100',
        state: 'Active',
        player1: 'GPLAYER1',
        player2: 'GPLAYER2',
        stakeAmount: '100',
        token: 'xlm',
        platform: 'lichess',
        gameId: 'game100',
        gameUrl: 'javascript:stealCredentials()',
      });

      render(<MatchStatus matchId="100" onFetchMatch={onFetchMatch} />);

      await waitFor(() => {
        expect(screen.getByTestId('state-active')).toBeInTheDocument();
      });

      // Must NOT render any clickable link
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chess-game-link')).not.toBeInTheDocument();
      // Rest of the match information is preserved
      expect(screen.getByTestId('state-active')).toHaveTextContent('game100');
    });
  });
});
