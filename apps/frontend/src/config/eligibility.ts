/**
 * Wagering eligibility shown to users (issue #113).
 *
 * The policy itself is docs/security.md#wagering-eligibility-policy. This module
 * only carries what the UI must say, from build-time configuration set per
 * deployment (docs/deployment.md#eligibility-enforcement):
 *
 *   VITE_MIN_WAGERING_AGE        default 18; values below 18 are ignored
 *   VITE_SUPPORTED_JURISDICTIONS comma-separated, e.g. "Malta, Isle of Man"
 *   VITE_ELIGIBILITY_TERMS_URL   link to the operator's terms / eligibility page
 *
 * The UI must never suggest wagering is legal for every user: with no
 * published jurisdiction list it says so explicitly.
 */

export const POLICY_MIN_AGE = 18;

type ViteEnv = {
  VITE_MIN_WAGERING_AGE?: string;
  VITE_SUPPORTED_JURISDICTIONS?: string;
  VITE_ELIGIBILITY_TERMS_URL?: string;
};

function viteEnv(): ViteEnv {
  return (typeof import.meta !== 'undefined' && (import.meta as { env?: ViteEnv }).env) || {};
}

export interface EligibilityConfig {
  minAge: number;
  jurisdictions: string[];
  termsUrl: string | null;
}

export function parseEligibilityConfig(env: ViteEnv = viteEnv()): EligibilityConfig {
  const age = Number.parseInt(env.VITE_MIN_WAGERING_AGE ?? '', 10);
  const jurisdictions = (env.VITE_SUPPORTED_JURISDICTIONS ?? '')
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean);
  const terms = (env.VITE_ELIGIBILITY_TERMS_URL ?? '').trim();
  return {
    // A deployment may raise the age (some jurisdictions require 21), never lower it.
    minAge: Number.isInteger(age) && age >= POLICY_MIN_AGE ? age : POLICY_MIN_AGE,
    jurisdictions: [...new Set(jurisdictions)],
    termsUrl: /^https:\/\//.test(terms) ? terms : null,
  };
}

export const ELIGIBILITY: EligibilityConfig = parseEligibilityConfig();
