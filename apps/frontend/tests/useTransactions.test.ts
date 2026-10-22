import {
  Account,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { simulateSignSubmitAndConfirm } from '../src/hooks/useTransactions';

const contract = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function makeTransaction() {
  return new TransactionBuilder(
    new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1'),
    {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    },
  )
    .addOperation(
      Operation.invokeContractFunction({
        contract,
        function: 'set_stake',
        args: [nativeToScVal(42n, { type: 'i128' })],
      }),
    )
    .setTimeout(30)
    .build();
}

function mockServer(status: string) {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({ minResourceFee: '100' }),
    sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-hash' }),
    getTransaction: vi.fn().mockResolvedValue({ status }),
  };
}

describe('simulateSignSubmitAndConfirm', () => {
  it('simulates and submits the same contract method and arguments, then confirms inclusion', async () => {
    const transaction = makeTransaction();
    const server = mockServer('SUCCESS');
    const assemble = vi.fn().mockReturnValue({
      build: () => transaction,
    });
    const signTransaction = vi.fn(async (xdr: string) => ({ signedTxXdr: xdr }));
    const states: string[] = [];

    const receipt = await simulateSignSubmitAndConfirm({
      transaction,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      signTransaction,
      assembleTransaction: assemble as unknown as typeof rpc.assembleTransaction,
      onStateChange: (state) => states.push(state),
      server: server as never,
    });

    expect(assemble).toHaveBeenCalledWith(transaction, expect.anything());
    expect(server.simulateTransaction).toHaveBeenCalledWith(transaction);
    const submitted = server.sendTransaction.mock.calls[0][0];
    expect(signTransaction).toHaveBeenCalledWith(transaction.toXDR(), {
      networkPassphrase: Networks.TESTNET,
    });
    const invocation = submitted.operations[0].func.invokeContract();
    expect(invocation.functionName().toString()).toBe('set_stake');
    expect(scValToNative(invocation.args()[0])).toBe(42n);
    expect(receipt).toEqual({ hash: 'tx-hash', confirmed: true });
    expect(states).toEqual(['submitted', 'pending', 'confirmed']);
  });

  it('fails after the confirmation polling limit', async () => {
    const server = mockServer('NOT_FOUND');
    const assemble = vi.fn().mockReturnValue({
      build: () => makeTransaction(),
    });
    const states: string[] = [];

    await expect(
      simulateSignSubmitAndConfirm({
        transaction: makeTransaction(),
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: Networks.TESTNET,
        signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
        assembleTransaction: assemble as unknown as typeof rpc.assembleTransaction,
        onStateChange: (state) => states.push(state),
        pollIntervalMs: 0,
        maxPolls: 2,
        server: server as never,
      }),
    ).rejects.toThrow('Timed out waiting for transaction confirmation');
    expect(server.getTransaction).toHaveBeenCalledTimes(2);
    expect(states[states.length - 1]).toBe('failed');
  });

  it('surfaces a terminal ledger failure', async () => {
    const server = mockServer('FAILED');
    const assemble = vi.fn().mockReturnValue({
      build: () => makeTransaction(),
    });

    await expect(
      simulateSignSubmitAndConfirm({
        transaction: makeTransaction(),
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: Networks.TESTNET,
        signTransaction: async (xdr) => ({ signedTxXdr: xdr }),
        assembleTransaction: assemble as unknown as typeof rpc.assembleTransaction,
        pollIntervalMs: 0,
        server: server as never,
      }),
    ).rejects.toThrow('Transaction failed on ledger');
  });
});
