import { Transaction, rpc } from '@stellar/stellar-sdk';

export type TransactionLifecycle = 'submitted' | 'pending' | 'confirmed' | 'failed';

export interface ConfirmedTransaction {
  hash: string;
  confirmed: true;
}

export interface SorobanSubmissionOptions {
  transaction: Transaction;
  rpcUrl: string;
  networkPassphrase: string;
  signTransaction: (
    xdr: string,
    options: { networkPassphrase: string },
  ) => Promise<{ signedTxXdr: string }>;
  onStateChange?: (state: TransactionLifecycle) => void;
  pollIntervalMs?: number;
  maxPolls?: number;
  assembleTransaction?: typeof rpc.assembleTransaction;
  /** Injected RPC server is useful for deterministic tests and custom transports. */
  server?: Pick<rpc.Server, 'simulateTransaction' | 'sendTransaction' | 'getTransaction'>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Simulate the built invocation, sign that invocation, submit it, and wait for ledger outcome. */
export async function simulateSignSubmitAndConfirm({
  transaction,
  rpcUrl,
  networkPassphrase,
  signTransaction,
  onStateChange,
  pollIntervalMs = 1_000,
  maxPolls = 60,
  assembleTransaction = rpc.assembleTransaction,
  server = new rpc.Server(rpcUrl),
}: SorobanSubmissionOptions): Promise<ConfirmedTransaction> {
  try {
    const simulation = await server.simulateTransaction(transaction);
    if ('error' in simulation) {
      throw new Error(`Transaction simulation failed: ${simulation.error}`);
    }

    // The assembler adds the simulation's auth tree and resource data to the
    // same invocation. Freighter signs this XDR, which is then submitted.
    const assembled = assembleTransaction(transaction, simulation).build();
    const { signedTxXdr } = await signTransaction(assembled.toXDR(), { networkPassphrase });
    const sendResult = await server.sendTransaction(
      new Transaction(signedTxXdr, networkPassphrase),
    );
    if (sendResult.status === 'ERROR') throw new Error('Transaction submission failed');
    if (!sendResult.hash) throw new Error('RPC did not return a transaction hash');

    onStateChange?.('submitted');
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      onStateChange?.('pending');
      const result = await server.getTransaction(sendResult.hash);
      if (result.status === 'SUCCESS') {
        onStateChange?.('confirmed');
        return { hash: sendResult.hash, confirmed: true };
      }
      if (result.status === 'FAILED') {
        throw new Error('Transaction failed on ledger');
      }
      if (attempt + 1 < maxPolls) await delay(pollIntervalMs);
    }
    throw new Error('Timed out waiting for transaction confirmation');
  } catch (error) {
    onStateChange?.('failed');
    throw error;
  }
}
