import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isNetworkMatch,
  validateNetworkMatch,
  assertExpectedNetwork,
  useNetworkStatus,
  EXPECTED_NETWORK,
  EXPECTED_PASSPHRASE,
  getExpectedNetwork,
} from '../src/hooks/useNetworkStatus';
import { useTransactions } from '../src/hooks/useTransactions';

// Mock freighterApi and stellar on window
interface MockFreighter {
  isConnected: ReturnType<typeof vi.fn>;
  getPublicKey: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
  signTransaction: ReturnType<typeof vi.fn>;
}

describe('Issue #1948 — Network Mismatch Detection', () => {
  let mockFreighter: MockFreighter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFreighter = {
      isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
      getPublicKey: vi.fn().mockResolvedValue('GBTESTWALLET123'),
      getNetwork: vi.fn().mockResolvedValue({
        network: 'testnet',
        networkPassphrase: EXPECTED_PASSPHRASE,
      }),
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'AAAA_SIGNED' }),
    };

    (window as { freighterApi?: unknown }).freighterApi = mockFreighter;
  });

  afterEach(() => {
    delete (window as { freighterApi?: unknown }).freighterApi;
    delete (window as { stellar?: unknown }).stellar;
  });

  describe('isNetworkMatch and validation utility', () => {
    it('accepts matching network name and matching passphrase', () => {
      expect(isNetworkMatch('testnet')).toBe(true);
      expect(
        isNetworkMatch({ network: 'testnet', networkPassphrase: EXPECTED_PASSPHRASE }),
      ).toBe(true);
    });

    it('rejects wrong network name or wrong passphrase', () => {
      expect(isNetworkMatch('mainnet')).toBe(false);
      expect(
        isNetworkMatch({
          network: 'testnet',
          networkPassphrase: 'Public Global Stellar Network ; September 2015',
        }),
      ).toBe(false);
      expect(
        isNetworkMatch({
          network: 'futurenet',
          networkPassphrase: 'Test SDF Future Network ; October 2022',
        }),
      ).toBe(false);
    });

    it('rejects unknown, null, or empty network identity safely', () => {
      expect(isNetworkMatch(null)).toBe(false);
      expect(isNetworkMatch(undefined)).toBe(false);
      expect(isNetworkMatch('')).toBe(false);
      expect(isNetworkMatch('unknown')).toBe(false);
      expect(isNetworkMatch({ network: 'unknown', networkPassphrase: '' })).toBe(false);
    });

    it('presents an actionable error message specifying the expected network', () => {
      const res = validateNetworkMatch('mainnet');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Wrong network detected: expected Testnet, but wallet is on Mainnet/i);
      expect(res.error).toMatch(/Please switch your wallet network/i);
    });

    it('handles unknown network with safe error message', () => {
      const res = validateNetworkMatch(null);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Wallet network is unavailable or unknown/i);
    });

    it('assertExpectedNetwork throws on mismatch and passes on match', () => {
      expect(() => assertExpectedNetwork('testnet')).not.toThrow();
      expect(() => assertExpectedNetwork('mainnet')).toThrow(/Wrong network detected/i);
    });
  });

  describe('useTransactions network safety boundary', () => {
    it('permits simulation and transaction flow on matching network', async () => {
      const { handleSimulateClaimBurn, handleClaim } = useTransactions(
        'GBTESTWALLET123',
        'testnet',
      );

      // Simulation on matching network
      const sim = await handleSimulateClaimBurn('claim', '10');
      // Should not return a network error
      expect(sim.error).toBeUndefined();

      // Write submission on matching network
      const hash = await handleClaim('10');
      expect(hash).toBeDefined();
      expect(mockFreighter.signTransaction).toHaveBeenCalled();
    });

    it('blocks simulation when wallet is on wrong network', async () => {
      mockFreighter.getNetwork.mockResolvedValue({
        network: 'mainnet',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      });

      const { handleSimulateClaimBurn } = useTransactions('GBTESTWALLET123', 'testnet');
      const sim = await handleSimulateClaimBurn('claim', '10');

      expect(sim.error).toMatch(/Wrong network detected/i);
      expect(sim.error).toMatch(/expected Testnet/i);
    });

    it('blocks write transaction preparation when wallet is on wrong network', async () => {
      mockFreighter.getNetwork.mockResolvedValue({
        network: 'mainnet',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      });

      const { handleClaim, handleCreateMatch, handleDeposit } = useTransactions(
        'GBTESTWALLET123',
        'testnet',
      );

      await expect(handleClaim('10')).rejects.toThrow(/Wrong network detected/i);
      await expect(
        handleCreateMatch({
          player2: 'GPLAYER2',
          stakeAmount: '10',
          token: 'xlm',
          gameId: 'game-1',
          platform: 'lichess',
        }),
      ).rejects.toThrow(/Wrong network detected/i);
      await expect(handleDeposit('1')).rejects.toThrow(/Wrong network detected/i);

      // Signature request should NOT have been invoked
      expect(mockFreighter.signTransaction).not.toHaveBeenCalled();
    });

    it('fails safely for write operations when wallet network is unknown or unavailable', async () => {
      mockFreighter.getNetwork.mockResolvedValue({
        network: 'unknown',
        networkPassphrase: '',
      });

      const { handleClaim } = useTransactions('GBTESTWALLET123', 'unknown');
      await expect(handleClaim('10')).rejects.toThrow(
        /Wallet network is unknown or still loading/i,
      );
      expect(mockFreighter.signTransaction).not.toHaveBeenCalled();
    });

    it('detects a network change that happens between preparation and signing', async () => {
      // First call (preparation check) passes, but by the time signing happens the network changed
      mockFreighter.getNetwork
        .mockResolvedValueOnce({
          network: 'testnet',
          networkPassphrase: EXPECTED_PASSPHRASE,
        })
        .mockResolvedValueOnce({
          network: 'mainnet',
          networkPassphrase: 'Public Global Stellar Network ; September 2015',
        });

      const { handleClaim } = useTransactions('GBTESTWALLET123', 'testnet');

      await expect(handleClaim('10')).rejects.toThrow(/Wrong network detected/i);
      expect(mockFreighter.signTransaction).not.toHaveBeenCalled();
    });
  });
});
