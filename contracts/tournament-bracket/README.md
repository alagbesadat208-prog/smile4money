# Tournament bracket record retention

## Policy: permanent, restorable records

Completed and cancelled tournaments retain their `Tournament` record and every
`MatchNode` in Soroban **persistent** storage. The contract does not delete,
compact, anonymize, or replace settled records. There is no application-level
archive state, purge deadline, or archive operation that can change a winner,
completion ledger, fee, funding flag, match result, payout, or refund.

This is a permanent-record policy, **not a promise of free, continuously live
storage**. Persistent entries can be archived by the network when their TTL
expires. They remain restorable; archival is not tournament cancellation and
restoration does not rerun settlement. See Stellar's
[state archival documentation](https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival).

## Queryability and renewal

- Each write extends that entry toward `MATCH_TTL_LEDGERS` (518,400 ledgers,
  approximately 30 days at five seconds per ledger), subject to network limits.
  Time is measured in ledgers, not wall-clock days.
- Tournament and node TTLs are independent. An early-round node can archive
  before the final tournament record. Completing a tournament does not renew
  every earlier node. Views do not renew any TTL.
- `extend_record_ttl(tournament_id)` renews a `Completed` or `Cancelled`
  tournament, all its nodes, and the shared contract instance/code toward the
  same TTL horizon. A keeper can call it before the earliest entry expires to
  maintain continuous access. It never shortens a longer TTL.
- Renewal is permissionless: the transaction payer pays network resource/rent
  fees; no entry fees, prize funds, or token balances are used. Repeated calls
  preserve every record value and emit no settlement events.
- One call visits exactly one tournament and at most 63 node keys (64 entrants).
  It never enumerates all tournaments or renews another tournament's persistent
  entries. Storage across all tournaments grows with tournament count; there is
  deliberately no global pruning policy.
- Unknown IDs return `TournamentNotFound`; unsettled tournaments return
  `InvalidState`. Missing nodes return `NodeNotFound` rather than being rebuilt.

While the required entries are live, the existing `get_tournament`, `get_node`,
`get_champion`, `get_prize_pool`, and `get_funded_count` views retain their existing
formats and meanings. A cancelled record has no champion; its funding flags and
count reflect the existing refund behavior, not a historical refund ledger.
The original `game_id` is not stored in a node; this policy does not add one.

## Restoring archived entries

Use transaction simulation and the network's restoration workflow before a
query or renewal that needs archived entries. Restore the contract instance and
WASM code if needed, the `Tournament(id)` persistent key, and the required
`Node(id, round, index)` keys. A full renewal needs every node, with
`0 <= round < rounds` and `0 <= index < player_count >> (round + 1)`.
Tooling may populate restoration automatically; otherwise use
`RestoreFootprintOp`. An archived entry can cause a host/restore error before
contract execution: do not interpret this as permission to recreate a tournament
or a guarantee that the contract will return `TournamentNotFound`.

After restoration, renew TTLs as needed and query the same records. Never call
`initialize`, resubmit results, or repeat refunds to reconstruct history.
Keepers should monitor the earliest relevant TTL and the current network limit.
Indexers should retain settlement events/transaction receipts independently;
RPC event-history availability is not guaranteed by this storage policy.

No stored addresses are erased by archival. Deployments should disclose that
participant identities and settlement data remain public and restorable.
Existing storage keys and record encodings are unchanged; no migration is needed.
The additive renewal entry point requires deploying this contract version.

## Verification

```sh
cargo test -p smile4money-tournament-bracket
```

Retention tests cover completed payouts, partial cancellation and timeout
refunds, repeated permissionless renewal, all 63 nodes, isolation from another
tournament, rejection of live/unknown/missing records, and queryability beyond
the original TTL horizon after renewal. They compare stored values and balances
before/after maintenance. Network archival/restoration itself is handled by
Soroban, not emulated by a contract-side delete/recreate operation.
