/** Public deployment metadata returned by a registry lookup. */
export type RegistryDeployment = {
  registryId: string;
  networkId: string;
  address: string;
  revision: number;
  effectiveLedger: number;
};

export type ExpectedDeployment = {
  registryId: string;
  networkId: string;
  minimumRevision?: number;
  latestLedger?: number;
};

/**
 * Reject a cached or superseded registry result before its address is used.
 * Callers provide the registry identity and network they configured for this
 * session; an optional ledger ceiling also rejects metadata from the future.
 */
export function isExpectedDeployment(
  deployment: RegistryDeployment,
  expected: ExpectedDeployment,
): boolean {
  return (
    deployment.registryId === expected.registryId &&
    deployment.networkId === expected.networkId &&
    Number.isSafeInteger(deployment.revision) &&
    deployment.revision > 0 &&
    deployment.revision >= (expected.minimumRevision ?? 1) &&
    Number.isSafeInteger(deployment.effectiveLedger) &&
    deployment.effectiveLedger >= 0 &&
    (expected.latestLedger === undefined ||
      deployment.effectiveLedger <= expected.latestLedger)
  );
}

/** Return an address only after all configured deployment checks pass. */
export function resolveRegistryAddress(
  deployment: RegistryDeployment,
  expected: ExpectedDeployment,
): string | null {
  return isExpectedDeployment(deployment, expected) && deployment.address.length > 0
    ? deployment.address
    : null;
}
