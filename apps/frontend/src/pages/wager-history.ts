import {
  Account,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import { deployment } from '../deployment';
import { formatTokenAmount } from '../token-amount';

export interface EscrowMatch {
  id: bigint;
  player1: string;
  player2: string;
  stake_amount: bigint;
  token: string;
  state: string[];
  pending_winner: [string, string[]?];
  player1_deposited: boolean;
  player2_deposited: boolean;
}

export function wagerRow(
  match: EscrowMatch,
  wallet: string,
  passphrase = deployment.networkPassphrase,
) {
  if (wallet !== match.player1 && wallet !== match.player2) return null;
  const first = wallet === match.player1;
  const deposited = first ? match.player1_deposited : match.player2_deposited;
  const state = match.state[0];
  const winner = match.pending_winner[0] === 'Some' ? match.pending_winner[1]?.[0] : undefined;
  let result = state;
  let payout: bigint | null = null;
  if (state === 'Completed') {
    if (!['Draw', 'Player1', 'Player2'].includes(winner ?? ''))
      throw new Error('Completed match has no valid outcome');
    result =
      winner === 'Draw' ? 'Draw' : winner === (first ? 'Player1' : 'Player2') ? 'Win' : 'Loss';
    payout =
      result === 'Draw' ? match.stake_amount : result === 'Win' ? match.stake_amount * 2n : 0n;
  } else if (state === 'Cancelled') {
    result = deposited ? 'Refund' : 'Cancelled (no deposit)';
    payout = deposited ? match.stake_amount : 0n;
  }
  return {
    id: String(match.id),
    opponent: first ? match.player2 : match.player1,
    stake: formatTokenAmount(String(match.stake_amount), match.token, passphrase),
    result,
    payout:
      payout === null ? 'Pending' : formatTokenAmount(String(payout), match.token, passphrase),
  };
}

/** Bounded pages of contract records; no transaction memo is treated as a match. */
export async function fetchWagerPage(wallet: string, before?: bigint) {
  const server = new rpc.Server(deployment.rpcUrl);
  async function read(method: string, id?: bigint) {
    const tx = new TransactionBuilder(new Account(wallet, '0'), {
      fee: '100',
      networkPassphrase: deployment.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: deployment.escrowId,
          function: method,
          args: id === undefined ? [] : [nativeToScVal(id, { type: 'u64' })],
        }),
      )
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if ('error' in sim || !sim.result?.retval)
      throw new Error('Unable to read escrow records (records may have expired)');
    return scValToNative(sim.result.retval);
  }
  let cursor = before ?? BigInt(await read('match_count'));
  const rows: NonNullable<ReturnType<typeof wagerRow>>[] = [];
  for (let scanned = 0; cursor > 0n && scanned < 20; scanned++) {
    cursor--;
    const row = wagerRow((await read('get_match', cursor)) as EscrowMatch, wallet);
    if (row) rows.push(row);
  }
  return { rows, cursor };
}
