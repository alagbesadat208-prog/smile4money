// @vitest-environment node
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signAndSubmitTransaction } from '../src/hooks/useTransactions';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async () => {
  const sdk = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return { ...sdk, rpc: { ...sdk.rpc, Server: vi.fn(() => ({ sendTransaction: send })) } };
});
const player = Keypair.random();
let signed: string;
beforeEach(() => {
  const tx = new TransactionBuilder(new Account(player.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
    .setTimeout(120)
    .build();
  tx.sign(player);
  signed = tx.toXDR();
  vi.stubGlobal('window', {});
  window.freighterApi = {
    signTransaction: vi.fn(async () => ({ signedTxXdr: signed })),
  } as unknown as typeof window.freighterApi;
  send.mockReset();
  send.mockResolvedValue({ status: 'PENDING', hash: 'direct' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it('submits unsponsored by default without contacting the sponsor', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await signAndSubmitTransaction(signed, 'testnet')).toBe('direct');
  expect(send).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});
it('sends only the player-signed inner transaction with explicit sponsorship consent', async () => {
  const fetch = vi.fn(async (_url: string, _options: { body: string }) => ({
    ok: true,
    json: async () => ({ hash: 'sponsored' }),
  }));
  vi.stubGlobal('fetch', fetch);
  expect(await signAndSubmitTransaction(signed, 'testnet', true)).toBe('sponsored');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ signedTxXdr: signed, optIn: true });
  expect(send).not.toHaveBeenCalled();
});
it('does not silently submit unsponsored when sponsorship fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({ error: 'budget exceeded' }) })),
  );
  await expect(signAndSubmitTransaction(signed, 'testnet', true)).rejects.toThrow(
    'budget exceeded',
  );
  expect(send).not.toHaveBeenCalled();
});
