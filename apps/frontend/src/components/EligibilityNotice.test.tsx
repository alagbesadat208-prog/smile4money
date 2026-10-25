import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EligibilityNotice } from './EligibilityNotice';
import { parseEligibilityConfig, POLICY_MIN_AGE } from '../config/eligibility';

// Only the member this test uses; pulling in vite/client would clash with the
// ImportMeta.env declaration in hooks/useWallet.ts.
declare global {
  interface ImportMeta {
    glob(
      patterns: string | string[],
      options: { query: string; import: string; eager: true },
    ): Record<string, unknown>;
  }
}

/** Eligibility notice and config (issue #113). */
describe('parseEligibilityConfig', () => {
  it('defaults to 18+, no published jurisdictions and no terms link', () => {
    expect(parseEligibilityConfig({})).toEqual({ minAge: 18, jurisdictions: [], termsUrl: null });
  });

  it('lets a deployment raise the age but never lower it below the policy minimum', () => {
    expect(parseEligibilityConfig({ VITE_MIN_WAGERING_AGE: '21' }).minAge).toBe(21);
    expect(parseEligibilityConfig({ VITE_MIN_WAGERING_AGE: '16' }).minAge).toBe(POLICY_MIN_AGE);
    expect(parseEligibilityConfig({ VITE_MIN_WAGERING_AGE: 'eighteen' }).minAge).toBe(
      POLICY_MIN_AGE,
    );
  });

  it('parses and de-duplicates the jurisdiction list, and only accepts an https terms URL', () => {
    const c = parseEligibilityConfig({
      VITE_SUPPORTED_JURISDICTIONS: ' Malta, Isle of Man,, Malta ',
      VITE_ELIGIBILITY_TERMS_URL: 'javascript:alert(1)',
    });
    expect(c.jurisdictions).toEqual(['Malta', 'Isle of Man']);
    expect(c.termsUrl).toBeNull();
    expect(
      parseEligibilityConfig({ VITE_ELIGIBILITY_TERMS_URL: 'https://example.org/terms' }).termsUrl,
    ).toBe('https://example.org/terms');
  });
});

describe('EligibilityNotice', () => {
  it('states the age limit and that no jurisdictions are published, so real funds must not be wagered', () => {
    render(
      <EligibilityNotice
        config={{ minAge: 18, jurisdictions: [], termsUrl: null }}
        network="mainnet"
      />,
    );
    const note = screen.getByRole('note', { name: 'Wagering eligibility' });
    expect(note.textContent).toMatch(/aged 18\+/);
    expect(note.textContent).toMatch(/has not published a list of supported jurisdictions/);
    expect(note.textContent).not.toMatch(/test network/);
  });

  it('lists the supported jurisdictions and links the terms when configured', () => {
    render(
      <EligibilityNotice
        config={{
          minAge: 21,
          jurisdictions: ['Malta', 'Isle of Man'],
          termsUrl: 'https://example.org/terms',
        }}
        network="mainnet"
      />,
    );
    const note = screen.getByRole('note', { name: 'Wagering eligibility' });
    expect(note.textContent).toMatch(/aged 21\+/);
    expect(note.textContent).toMatch(/Supported jurisdictions: Malta, Isle of Man\./);
    expect(screen.getByRole('link', { name: 'Eligibility terms' }).getAttribute('href')).toBe(
      'https://example.org/terms',
    );
  });

  it('says test-network stakes have no real value', () => {
    render(
      <EligibilityNotice
        config={{ minAge: 18, jurisdictions: [], termsUrl: null }}
        network="testnet"
      />,
    );
    expect(screen.getByRole('note').textContent).toMatch(/test tokens with no real value/);
  });
});

describe('UI copy', () => {
  // Phrases that would imply the service is legally available to everyone.
  const BANNED = [
    /available (?:worldwide|everywhere|globally|to (?:all|everyone))/i,
    /anyone,? anywhere/i,
    /legal everywhere/i,
    /no restrictions/i,
  ];

  // Every app source file and the HTML shell, read as text by Vite.
  const sources = {
    ...import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
    ...import.meta.glob('../../index.html', { query: '?raw', import: 'default', eager: true }),
  } as Record<string, string>;

  it('never implies universal legal availability', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const hits = Object.entries(sources).flatMap(([file, text]) =>
      BANNED.filter((re) => re.test(text)).map((re) => `${file}: ${re}`),
    );
    expect(hits).toEqual([]);
  });
});
