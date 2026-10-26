use soroban_sdk::{contracttype, Address};

/// Schema version written to every newly created tournament record.
pub const TOURNAMENT_SCHEMA_VERSION: u32 = 1;

/// Lifecycle of a tournament.
///
/// ```text
/// (none) ──create_tournament──► Registration
///                                  │
///                        all entrants deposit
///                                  │
///                                  ▼
///                             InProgress
///                                  │
///                     final decided  │  cancel_tournament / claim_timeout
///                                  │            │
///                     ┌────────────┘            └──────────┐
///                     ▼                                  ▼
///                 Completed                          Cancelled
/// ```
///
/// `Completed` and `Cancelled` are **terminal states**.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TournamentState {
    /// The bracket has been created but not every entrant has paid their entry
    /// fee yet. No match can be decided in this state.
    Registration,

    /// Every entrant has paid, so the first round is under way.
    InProgress,

    /// The final has been decided and the prize is allocated to the champion.
    /// Claims may remain outstanding. **Terminal for bracket progression.**
    Completed,

    /// The tournament was abandoned before a champion emerged. Every funded
    /// entrant may claim their refund. **Terminal for bracket progression.**
    Cancelled,
}

/// Lifecycle of a single node (one match) in the bracket.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeStatus {
    /// A first-round node still waiting for one or both entrants to pay their
    /// entry fee. A node is created in this state.
    ///
    /// Later-round nodes are also created in this state but are promoted to
    /// `AwaitingResult` as soon as both slots are filled by advancement, since
    /// those entrants already paid at the start of the tournament.
    AwaitingFunding,

    /// Both entrants are known and funded. The oracle may report a result.
    AwaitingResult,

    /// The oracle has reported a result. [`MatchNode::winner`] is set and, unless
    /// this was the final, the winner has been written into the parent node.
    /// **Terminal.**
    Decided,
}

/// A tournament and everything needed to run it.
///
/// Stored in **persistent** storage under [`DataKey::Tournament`], with the TTL
/// extended to `MATCH_TTL_LEDGERS` (~30 days) on every write.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tournament {
    /// Unique, auto-incrementing identifier. Assigned from the `TournamentCount`
    /// counter at `create_tournament` time.
    pub id: u64,

    /// The administrator who created this tournament. Only this address may
    /// `cancel_tournament` while the tournament is still in `Registration`.
    pub admin: Address,

    /// The SEP-41 token the entry fees are paid in and the prize pool is paid out
    /// in. Fixed at `initialize` time for the whole contract.
    pub token: Address,

    /// The fee each entrant pays, in the smallest unit of [`token`](Tournament::token).
    ///
    /// The total prize pool is `entry_fee × player_count`. It is paid to the
    /// champion in one claim after the final is decided — no per-match payouts
    /// happen during the tournament, because paying each match's winner
    /// `2 × entry_fee` would drain the whole pot in the first round.
    pub entry_fee: i128,

    /// Number of entrants. Always a power of two in `[2, 64]`, so no entrant ever
    /// receives a bye.
    pub player_count: u32,

    /// Number of rounds, i.e. `log2(player_count)`. Round 0 is the first round
    /// and round `rounds - 1` is the final.
    pub rounds: u32,

    /// How many entrants have paid their entry fee so far. Reaches
    /// `player_count` when the tournament moves to
    /// [`InProgress`](TournamentState::InProgress). After cancellation, counts
    /// funded entrants whose refund has not yet been claimed.
    pub funded_count: u32,

    /// The current lifecycle state. See [`TournamentState`].
    pub state: TournamentState,

    /// The winner of the tournament, set when the final is decided.
    /// `None` until then, and forever on a `Cancelled` tournament.
    pub champion: Option<Address>,

    /// The ledger at which `create_tournament` ran. `claim_timeout` measures
    /// `TIMEOUT_LEDGERS` from here.
    pub created_ledger: u32,

    /// The ledger at which the tournament reached a terminal state.
    /// `None` while it is still running.
    pub completed_ledger: Option<u32>,

    /// Stored schema version. Readers reject records with an unknown version.
    pub schema_version: u32,
}

/// One match in the bracket: a node in the single-elimination tree.
///
/// A tournament of `N` entrants has exactly `N - 1` of these. Node `(r, i)`
/// feeds node `(r + 1, i / 2)`, entering its `player1` slot when `i` is even and
/// its `player2` slot when `i` is odd.
///
/// Stored in **persistent** storage under [`DataKey::Node`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchNode {
    /// The tournament this node belongs to.
    pub tournament_id: u64,

    /// Round index, 0-based. Round 0 is the first round.
    pub round: u32,

    /// Index of the node within its round, 0-based.
    pub index: u32,

    /// First entrant. Fixed at `create_tournament` time for round-0 nodes;
    /// filled by advancement for later rounds.
    pub player1: Option<Address>,

    /// Second entrant. See [`player1`](MatchNode::player1).
    pub player2: Option<Address>,

    /// Whether [`player1`](MatchNode::player1) has paid their entry fee.
    /// Later-round nodes are never set here: those entrants paid at the start of
    /// the tournament.
    pub funded1: bool,

    /// Whether [`player2`](MatchNode::player2) has paid their entry fee.
    /// See [`funded1`](MatchNode::funded1).
    pub funded2: bool,

    /// The winner reported by the oracle. `None` until the node is `Decided`.
    pub winner: Option<Address>,

    /// The current lifecycle state. See [`NodeStatus`].
    pub status: NodeStatus,

    /// The ledger at which the oracle reported a result.
    /// `None` until the node is `Decided`.
    pub result_ledger: Option<u32>,
}

/// Storage keys used by the tournament bracket contract.
///
/// | Key variant                | Storage tier | Description                                       |
/// |----------------------------|--------------|---------------------------------------------------|
/// | `Tournament(u64)`          | Persistent   | [`Tournament`] record, keyed by tournament ID     |
/// | `Node(u64, u32, u32)`      | Persistent   | [`MatchNode`] record, keyed by (id, round, index) |
/// | `TournamentCount`          | Instance     | Running counter used to assign tournament IDs     |
/// | `Oracle`                   | Instance     | Address allowed to report match results           |
/// | `Admin`                    | Instance     | Contract administrator                           |
/// | `Token`                    | Instance     | The SEP-41 token all fees and prizes use          |
#[contracttype]
pub enum DataKey {
    /// Stores the [`Tournament`] record for the given tournament ID.
    Tournament(u64),

    /// Stores the [`MatchNode`] record at the given coordinates.
    Node(u64, u32, u32),

    /// Running counter that tracks the total number of tournaments created.
    TournamentCount,

    /// The address permitted to call `submit_match_result`.
    Oracle,

    /// The contract administrator.
    Admin,

    /// The SEP-41 token address configured at `initialize` time.
    Token,

    /// Allocation totals and resumable claim progress.
    Settlement(u64),
}

/// Allocation created exactly once when a tournament becomes terminal. The
/// claimed bitmap shares this record's lifetime: no individual claim marker can
/// expire while funds remain claimable. Refund bit 2*i is node i's first player;
/// bit 2*i+1 is its second player (round zero).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub total: i128,
    pub remaining: i128,
    pub unclaimed: u32,
    pub claimed: u64,
}
