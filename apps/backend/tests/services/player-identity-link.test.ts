import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';
import {
  confirmIdentityLink,
  createIdentityLinkChallenge,
  getLinkedWallet,
} from '../../src/services/player-identity.js';

describe('wallet identity linking proof', () => {
  beforeEach(() => vi.useRealTimers());

  function proof(pair: Keypair, message: string): string {
    return pair
      .sign(createHash('sha256').update(message).digest())
      .toString('hex');
  }

  it('accepts a wallet proof once and stores the link', () => {
    const wallet = Keypair.random();
    const challenge = createIdentityLinkChallenge(
      wallet.publicKey(),
      'lichess',
      'Alice',
    );
    const signature = proof(wallet, challenge.message);
    expect(
      confirmIdentityLink(challenge.nonce, wallet.publicKey(), signature),
    ).toBe(true);
    expect(
      confirmIdentityLink(challenge.nonce, wallet.publicKey(), signature),
    ).toBe(false);
    expect(getLinkedWallet('lichess', 'alice')).toBe(wallet.publicKey());
  });

  it('rejects wrong-wallet and expired proofs', () => {
    const wallet = Keypair.random();
    const otherWallet = Keypair.random();
    const challenge = createIdentityLinkChallenge(
      wallet.publicKey(),
      'chessdotcom',
      'Bob',
    );
    expect(
      confirmIdentityLink(
        challenge.nonce,
        otherWallet.publicKey(),
        proof(otherWallet, challenge.message),
      ),
    ).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    expect(
      confirmIdentityLink(
        challenge.nonce,
        wallet.publicKey(),
        proof(wallet, challenge.message),
      ),
    ).toBe(false);
  });
});
