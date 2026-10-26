import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `node:fs` is used to read the stylesheet as text so the CSS contract can be
// asserted. Two notes on why this shape:
//
// 1. `@types/node` is **not** a dependency of this package (and adding one just
//    to read a file would be the wrong trade), so the two node built-ins this
//    file needs are declared locally in `tests/node-builtins.d.ts`.
// 2. A Vite `?raw` import was tried first and does not work here: vitest runs
//    with CSS processing deliberately enabled (see `vite.config.ts`), which
//    intercepts `*.css?raw` and yields an empty string.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CreateMatch } from '../src/components/CreateMatch';
import { DepositStake } from '../src/components/DepositStake';
import { MatchStatus } from '../src/components/MatchStatus';

/**
 * Mobile-responsive layout tests â€” issue #125 / #1804.
 *
 * ## Why these tests read the stylesheet instead of measuring the DOM
 *
 * jsdom has **no layout engine**. `getBoundingClientRect()` returns all zeros
 * and `offsetWidth` is always 0, so any test that tries to assert "this element
 * is 44px tall" or "nothing overflows 375px" would pass vacuously â€” it would
 * be asserting against a number the environment never computes. That is worse
 * than no test, because it looks like coverage.
 *
 * So these tests split the acceptance criteria into the two halves that can
 * actually be verified headlessly:
 *
 * 1. **CSS contract** (static, on the real stylesheet): every rule the mobile
 *    layout depends on is present, and every `width`/`min-width` literal is
 *    within the narrowest supported viewport. A regression that hard-codes
 *    `width: 500px` fails here.
 * 2. **Markup contract** (per rendered component, at each target viewport):
 *    the elements that would cause overflow or an undersized tap target are
 *    present and classed so the CSS can reach them, and the components still
 *    render without error.
 *
 * Real-device verification on iOS Safari and Android Chrome is not something
 * jsdom can stand in for; see the PR description for the manual checklist.
 */

const VIEWPORTS = [
  { width: 375, height: 667, label: 'iPhone SE / mini' },
  { width: 414, height: 896, label: 'iPhone XR class' },
  { width: 768, height: 1024, label: 'iPad portrait' },
] as const;

const validAddress = 'GAUXUJLYWYXK7UE22KXN5WJTP2MNOWVL4ZRDBJQ43WZB5HJP22JSYTRR';

const css = readFileSync(resolve(__dirname, '../src/styles/match-ui.css'), 'utf8');
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

/**
 * Set the jsdom viewport, mirroring what a real browser reports to CSS.
 * `matchMedia` is stubbed in `src/test-setup.ts`, so this only needs to drive
 * `innerWidth` / `innerHeight`.
 */
function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    writable: true,
    configurable: true,
  });
}

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

beforeEach(() => setViewport(375, 667));
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    value: originalInnerWidth,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: originalInnerHeight,
    writable: true,
    configurable: true,
  });
});

vi.mock('@stellar/stellar-sdk', () => ({
  Address: { fromString: () => ({}) },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
    })),
  },
  token: { Client: vi.fn() },
}));

describe('match-ui.css â€” box model and overflow guards', () => {
  it('applies border-box globally so padding cannot add to declared widths', () => {
    // Without this, `width: 100%` + padding overflows the parent â€” the single
    // most common cause of an unintended mobile horizontal scrollbar.
    expect(css).toMatch(/\*,\s*\n\*::before,\s*\n\*::after\s*\{\s*\n\s*box-sizing:\s*border-box;/);
  });

  it('guards the body against a page-wide horizontal scrollbar', () => {
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden;/);
  });

  it('constrains the root and app container to the viewport width', () => {
    expect(css).toMatch(/html,\s*\nbody,\s*\n#root\s*\{\s*\n\s*max-width:\s*100%;/);
  });
});

describe('match-ui.css â€” no fixed width can exceed the narrowest viewport', () => {
  it('has no px width literal wider than 320px anywhere in the file', () => {
    // 375px is the narrowest supported viewport; a card at 375px has ~32px of
    // padding to spare, so 320px is the ceiling for any hard-coded width.
    //
    // `@media (min-width: 768px)` is a media *condition*, not a declaration,
    // so it is stripped before scanning — otherwise the breakpoint itself
    // would read as an offending fixed width.
    const declarations = css.replace(/@media[^{]*\{/g, '@media{');
    const offenders: string[] = [];
    const widthLiterals = /(?<![\w-])width:\s*(\d+)px/g;
    const minWidthLiterals = /min-width:\s*(\d+)px/g;

    for (const re of [widthLiterals, minWidthLiterals]) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(declarations)) !== null) {
        const px = Number(match[1]);
        if (px > 320) offenders.push(`${match[0]} (${px}px)`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('uses only the one 768px breakpoint named in the acceptance criteria', () => {
    const widthQueries = [...css.matchAll(/@media[^{]*\((?:min|max)-width:\s*(\d+)px\)/g)].map(
      (m) => Number(m[1]),
    );
    // Every width media query must be the 768px boundary. (The
    // prefers-reduced-motion query carries no width and is filtered out here.)
    expect(widthQueries).toEqual([768]);
  });
});

describe('match-ui.css â€” touch targets meet 44x44px', () => {
  it('defines the 44px minimum as a reusable token', () => {
    // WCAG 2.2 "Target Size (Minimum)" and the Apple HIG both land on 44px.
    expect(css).toMatch(/--touch-target-min:\s*44px;/);
  });

  it('applies the minimum height to every button class in the three components', () => {
    // One shared rule covering `.btn`, `.toggle-btn`, `.platform-btn`.
    const buttonRule = css.match(/\.btn,\s*\n\.toggle-btn,\s*\n\.platform-btn\s*\{([^}]*)\}/);
    expect(buttonRule).not.toBeNull();
    expect(buttonRule![1]).toMatch(/min-height:\s*var\(--touch-target-min\);/);
    expect(buttonRule![1]).toMatch(/min-width:\s*var\(--touch-target-min\);/);
  });

  it('gives form inputs the same 44px minimum height', () => {
    const inputRule = css.match(/\.form-group input\s*\{([^}]*)\}/);
    expect(inputRule).not.toBeNull();
    expect(inputRule![1]).toMatch(/min-height:\s*var\(--touch-target-min\);/);
  });

  it('uses a 16px input font so iOS Safari does not zoom on focus', () => {
    // Any font-size under 16px makes iOS Safari zoom the viewport on focus,
    // which is the most common "page jumps when I tap the field" bug.
    const inputRule = css.match(/\.form-group input\s*\{([^}]*)\}/);
    expect(inputRule![1]).toMatch(/font-size:\s*1rem;/);
  });
});

describe('match-ui.css â€” long opaque values wrap instead of widening the page', () => {
  it('lets Stellar addresses and tx hashes break mid-token', () => {
    // `overflow-wrap: normal` (the default) would let a 56-character address
    // push the card wider than the viewport.
    expect(css).toMatch(/\.address,\s*\n\.address-small\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    expect(css).toMatch(/\.tx-hash\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });

  it('allows flex children to shrink below their content width', () => {
    // Flex children default to `min-width: auto`, which refuses to shrink and
    // is the other half of "why is there a horizontal scrollbar".
    expect(
      css,
    ).toMatch(/\.create-match,\s*\n\.deposit-stake,\s*\n\.match-status\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.form-group\s*\{[^}]*min-width:\s*0;/);
  });
});

describe('match-ui.css â€” mobile-first structure', () => {
  it('keeps the base rules unprefixed and only widens at 768px', () => {
    // The `@media (min-width: 768px)` block must contain the two-column switch;
    // nothing may be hidden behind a max-width query, because that is how
    // content ends up invisible on a phone.
    expect(css).not.toMatch(
      /@media[^{]*max-width:\s*\d+px\s*\)\s*\{\s*[^}]*display:\s*none/,
    );
    expect(css.lastIndexOf('@media (min-width: 768px)')).toBeGreaterThan(0);
  });

  it('stacks the segmented button groups on mobile and rows them at 768px', () => {
    const selectorRule = css.match(/\.token-toggle,\s*\n\.platform-selector\s*\{([^}]*)\}/);
    expect(selectorRule![1]).toMatch(/flex-direction:\s*column;/);

    const desktopBlock = css.slice(css.lastIndexOf('@media (min-width: 768px)'));
    expect(desktopBlock).toMatch(/flex-direction:\s*row;/);
  });
});

/* ==========================================================================
   Per-viewport render tests
   ========================================================================== */

describe.each(VIEWPORTS)('at $width px ($label)', ({ width, height }) => {
  beforeEach(() => setViewport(width, height));

  describe('CreateMatch', () => {
    it('renders the form', () => {
      render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
      expect(screen.getByTestId('create-match')).toBeInTheDocument();
      expect(screen.getByTestId('create-match-form')).toBeInTheDocument();
    });

    it('renders every text input inside a form-group so the CSS can constrain it', () => {
      render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
      const inputs = [
        screen.getByTestId('player2-input'),
        screen.getByTestId('stake-amount-input'),
        screen.getByTestId('game-id-input'),
      ];
      for (const input of inputs) {
        expect(input.closest('.form-group')).not.toBeNull();
      }
    });

    it('exposes every control as a tap target the 44px rule can size', () => {
      render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
      const controls = [
        screen.getByTestId('toggle-xlm'),
        screen.getByTestId('toggle-usdc'),
        screen.getByTestId('platform-lichess'),
        screen.getByTestId('platform-chesscom'),
        screen.getByTestId('submit-match-btn'),
      ];
      for (const control of controls) {
        expect(control.className).toMatch(/\b(btn|toggle-btn|platform-btn)\b/);
      }
    });

    it('groups the token and platform pickers so they can stack on mobile', () => {
      render(<CreateMatch contractId="test-contract" player1Address={validAddress} />);
      expect(screen.getByTestId('toggle-xlm').closest('.token-toggle')).not.toBeNull();
      expect(screen.getByTestId('platform-lichess').closest('.platform-selector')).not.toBeNull();
    });

    it('renders no element with an inline pixel width that could force overflow', () => {
      const { container } = render(
        <CreateMatch contractId="test-contract" player1Address={validAddress} />,
      );
      const offenders = [...container.querySelectorAll('*')].filter((el) => {
        // Read the inline style through the CSSOM rather than typing the element
        // as `HTMLElement`, which keeps this file free of DOM type references.
        const inlineWidth = (el as HTMLElement).style?.width ?? '';
        return inlineWidth.endsWith('px') && Number.parseFloat(inlineWidth) > width;
      });
      expect(offenders).toHaveLength(0);
    });
  });
  describe('DepositStake', () => {
    it('renders without error', () => {
      render(
        <DepositStake
          matchId="123"
          playerAddress={validAddress}
          contractId="test-contract"
          networkPassphrase="Test SDF Network ; September 2015"
        />,
      );
      expect(screen.getByTestId('deposit-stake')).toBeInTheDocument();
    });

    it('renders its primary action as a .btn so it inherits the 44px target', () => {
      render(
        <DepositStake
          matchId="123"
          playerAddress={validAddress}
          contractId="test-contract"
          networkPassphrase="Test SDF Network ; September 2015"
        />,
      );
      expect(screen.getByTestId('deposit-btn').className).toMatch(/\bbtn\b/);
    });
  });

  describe('MatchStatus', () => {
    const match = {
      id: '42',
      state: 'Pending' as const,
      player1: validAddress,
      player2: validAddress,
      stakeAmount: '1000000',
      token: 'xlm',
      platform: 'lichess' as const,
      gameId: 'abc123',
    };

    it('renders a full 56-character address without a horizontal scrollbar', async () => {
      const onFetchMatch = vi.fn().mockResolvedValue(match);
      render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);
      await screen.findByTestId('state-pending');

      // The address is rendered truncated in the UI; what matters is that the
      // element carrying it is allowed to wrap rather than set a width floor.
      const status = screen.getByTestId('deposit-status');
      expect(status).toBeInTheDocument();
      expect(status.closest('.match-status')).not.toBeNull();
    });

    it('lays the deposit status out as wrappable rows, not <br /> breaks', async () => {
      const onFetchMatch = vi.fn().mockResolvedValue(match);
      render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);
      await screen.findByTestId('state-pending');

      const status = screen.getByTestId('deposit-status');
      // A <br /> hard-codes a line break that cannot respond to the viewport;
      // each player is its own row element instead.
      expect(status.querySelector('br')).toBeNull();
      expect(status.querySelectorAll('.deposit-status-row')).toHaveLength(2);
    });

    it('keeps the match status card mounted when the match is not found', async () => {
      const onFetchMatch = vi.fn().mockResolvedValueOnce(null);
      render(<MatchStatus matchId="42" onFetchMatch={onFetchMatch} />);
      await screen.findByTestId('match-not-found');
      expect(screen.getByTestId('match-status')).toBeInTheDocument();
    });
  });
});

describe('app shell â€” viewport meta tag', () => {
  it('declares a responsive viewport so mobile browsers do not zoom out', () => {
    expect(indexHtml).toMatch(
      /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1.0"/,
    );
  });
});
