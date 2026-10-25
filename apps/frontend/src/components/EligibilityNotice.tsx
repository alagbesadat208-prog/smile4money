import React from 'react';
import { ELIGIBILITY, type EligibilityConfig } from '../config/eligibility';
import { APP_NETWORK } from '../config/network';

interface EligibilityNoticeProps {
  /** Overrides the build-time config; for tests and previews. */
  config?: EligibilityConfig;
  /** Overrides the app network; for tests and previews. */
  network?: string;
  className?: string;
}

/**
 * States who may wager and where (issue #113), wherever the UI moves money.
 * Policy: docs/security.md#wagering-eligibility-policy.
 */
export function EligibilityNotice({
  config = ELIGIBILITY,
  network = APP_NETWORK,
  className,
}: EligibilityNoticeProps) {
  const { minAge, jurisdictions, termsUrl } = config;
  const isTestNetwork = network !== 'mainnet';
  return (
    <aside
      role="note"
      aria-label="Wagering eligibility"
      data-testid="eligibility-notice"
      className={
        className ??
        'mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100'
      }
    >
      <p>
        <strong>Real-money wagering is restricted.</strong> It is only for people aged {minAge}+ (or
        older where local law requires) who are located in a jurisdiction where it is legal and that
        this service supports.{' '}
        {jurisdictions.length > 0 ? (
          <>Supported jurisdictions: {jurisdictions.join(', ')}.</>
        ) : (
          <>
            This deployment has not published a list of supported jurisdictions, so do not wager
            real funds.
          </>
        )}{' '}
        You are responsible for checking that wagering is legal where you are.
        {termsUrl && (
          <>
            {' '}
            <a href={termsUrl} target="_blank" rel="noopener noreferrer" className="underline">
              Eligibility terms
            </a>
          </>
        )}
      </p>
      {isTestNetwork && (
        <p className="mt-1">
          You are on a test network: stakes use test tokens with no real value.
        </p>
      )}
    </aside>
  );
}

export default EligibilityNotice;
