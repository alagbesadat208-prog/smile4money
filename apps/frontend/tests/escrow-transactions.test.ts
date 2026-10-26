// @vitest-environment node
import {
  Account,
  Asset,
  Networks,
  Keypair,
  Transaction,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTransactions } from '../src/hooks/useTransactions';
const { account, prepare, send, poll } = vi.hoisted(() => ({
  account: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  poll: vi.fn(),
}));
vi.mock('@stellar/stellar-sdk', async () => {
  const sdk = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...sdk,
    rpc: {
      ...sdk.rpc,
      Server: vi.fn(() => ({
        getAccount: account,
        prepareTransaction: prepare,
        sendTransaction: send,
        pollTransaction: poll,
      })),
    },
  };
});
const player = Keypair.random();
const opponent = Keypair.random();
const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
beforeEach(() => {
  vi.stubGlobal('window', {
    freighterApi: { signTransaction: vi.fn(async (tx: string) => ({ signedTxXdr: tx })) },
  });
  account.mockResolvedValue(new Account(player.publicKey(), '1'));
  prepare.mockImplementation(async (tx) => tx);
  send.mockResolvedValue({ status: 'PENDING', hash: 'hash' });
  poll.mockResolvedValue({ status: 'SUCCESS', returnValue: nativeToScVal(42n, { type: 'u64' }) });
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('prepares a typed create_match invocation and returns its on-chain ID', async () => {
  const actions = useTransactions(player.publicKey(), 'testnet', { contractId });
  expect(
    await actions.handleCreateMatch({
      player2: opponent.publicKey(),
      stakeAmount: '10000000',
      token: 'xlm',
      gameId: 'game1',
      platform: 'lichess',
    }),
  ).toBe('42');
  const tx = send.mock.calls[0][0] as Transaction;
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') throw new Error('Expected contract invocation');
  const call = op.func.invokeContract();
  expect(call.functionName().toString()).toBe('create_match');
  expect(call.args().map((value) => scValToNative(value))).toEqual([
    player.publicKey(),
    opponent.publicKey(),
    10000000n,
    Asset.native().contractId(Networks.TESTNET),
    'game1',
    ['Lichess'],
  ]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledWith('hash');
});
it('waits for deposit success and rejects failed ledger execution', async () => {
  const actions = useTransactions(player.publicKey(), 'testnet', { contractId });
  await actions.handleDeposit('42');
  const tx = send.mock.calls[0][0] as Transaction;
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') throw new Error('Expected contract invocation');
  expect(op.func.invokeContract().functionName().toString()).toBe('deposit');
  expect(
    op.func
      .invokeContract()
      .args()
      .map((value) => scValToNative(value)),
  ).toEqual([42n, player.publicKey()]);
  poll.mockResolvedValueOnce({ status: 'FAILED' });
  await expect(actions.handleDeposit('42')).rejects.toThrow('Deposit failed');
});
