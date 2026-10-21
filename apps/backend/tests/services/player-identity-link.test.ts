import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';
import axios from 'axios';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
import {
  confirmIdentityLink,
  createIdentityLinkChallenge,
  getLinkedWallet,
} from '../../src/services/player-identity.js';

const mockAxiosGet = vi.mocked(axios.get);

describe('wallet identity linking proof', () => {
  beforeEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  function proof(pair: Keypair, message: string): string {
    return pair
      .sign(createHash('sha256').update(message).digest())
      .toString('hex');
  }

  it('accepts a wallet and chess profile proof once and stores the link', async () => {
    const wallet = Keypair.random();
    const challenge = createIdentityLinkChallenge(
      wallet.publicKey(),
      'lichess',
      'Alice',
    );
    const signature = proof(wallet, challenge.message);
    expect(await confirmIdentityLink(challenge.nonce, wallet.publicKey(), signature, async () => true)).toBe(true);
    expect(await confirmIdentityLink(challenge.nonce, wallet.publicKey(), signature, async () => true)).toBe(false);
    expect(getLinkedWallet('lichess', 'alice')).toBe(wallet.publicKey());
  });

  it('rejects wrong-wallet and expired proofs', async () => {
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
    ).resolves.toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    expect(
      confirmIdentityLink(
        challenge.nonce,
        wallet.publicKey(),
        proof(wallet, challenge.message),
      ),
    ).resolves.toBe(false);
  });

  it('requires the chess profile to publish the nonce proof', async () => {
    const wallet = Keypair.random();
    const challenge = createIdentityLinkChallenge(wallet.publicKey(), 'lichess', 'Carol');
    const signature = proof(wallet, challenge.message);
    expect(challenge.profileProof).toBe(`smile4money:${challenge.nonce}`);
    expect(await confirmIdentityLink(challenge.nonce, wallet.publicKey(), signature, async () => false)).toBe(false);
    expect(await confirmIdentityLink(challenge.nonce, wallet.publicKey(), signature, async () => true)).toBe(true);
  });

  it('confirms against the public Lichess profile proof', async () => {
    const wallet = Keypair.random();
    const challenge = createIdentityLinkChallenge(wallet.publicKey(), 'lichess', 'Dana');
    mockAxiosGet.mockResolvedValueOnce({ data: { username: 'Dana', profile: { bio: challenge.profileProof } } } as any);
    expect(await confirmIdentityLink(challenge.nonce, wallet.publicKey(), proof(wallet, challenge.message))).toBe(true);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://lichess.org/api/user/Dana',
      expect.objectContaining({ timeout: 10_000 }),
    );
  });
});
