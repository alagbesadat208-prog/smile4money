import {
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { MatchData } from '../components/MatchStatus';

export function escrowRpcUrl(networkPassphrase: string) {
  if (networkPassphrase === Networks.TESTNET) return 'https://soroban-testnet.stellar.org';
  if (networkPassphrase === Networks.PUBLIC) return 'https://soroban-mainnet.stellar.org';
  throw new Error('Unsupported Stellar network');
}
export function escrowServer(networkPassphrase: string) {
  return new rpc.Server(escrowRpcUrl(networkPassphrase));
}
export async function buildEscrowCall(
  address: string,
  contractId: string,
  networkPassphrase: string,
  method: string,
  args: xdr.ScVal[],
) {
  if (!contractId) throw new Error('No escrow contract configured');
  const server = escrowServer(networkPassphrase);
  const source = await server.getAccount(address);
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  return (await server.prepareTransaction(tx)).toXDR();
}
export async function fetchMatchStatus(
  id: string,
  contractId: string,
  passphrase: string,
  address: string | null,
): Promise<MatchData> {
  if (!address) throw new Error('Connect wallet to load match details');
  if (!/^\d+$/.test(id) || !contractId) throw new Error('Invalid match ID or escrow configuration');
  const server = escrowServer(passphrase);
  const source = await server.getAccount(address);
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: passphrase })
    .addOperation(
      new Contract(contractId).call('get_match', nativeToScVal(BigInt(id), { type: 'u64' })),
    )
    .setTimeout(30)
    .build();
  const result = await server.simulateTransaction(tx);
  if ('error' in result || !result.result) throw new Error('Could not load match');
  const raw = scValToNative(result.result.retval);
  const enumName = (value: unknown) => (Array.isArray(value) ? String(value[0]) : String(value));
  const winnerValue =
    raw.winner ??
    (Array.isArray(raw.pending_winner) && raw.pending_winner[0] === 'Some'
      ? raw.pending_winner[1]
      : undefined);
  const winner = winnerValue ? enumName(winnerValue) : undefined;
  return {
    id,
    state: enumName(raw.state) as MatchData['state'],
    player1: raw.player1,
    player2: raw.player2,
    stakeAmount: String(raw.stake_amount),
    token: raw.token,
    platform: enumName(raw.platform) === 'Lichess' ? 'lichess' : 'chesscom',
    gameId: raw.game_id,
    winner: ['Player1', 'Player2', 'Draw'].includes(winner ?? '')
      ? (winner as MatchData['winner'])
      : undefined,
    player1Deposited: raw.player1_deposited,
    player2Deposited: raw.player2_deposited,
    pendingResultLedger: Number(raw.pending_result_ledger ?? 0),
    currentLedger: result.latestLedger,
  };
}
export const addressValue = (address: string) => new Address(address).toScVal();
