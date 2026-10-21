use soroban_sdk::{contracterror, contracttype, Address};

/// Errors returned by the leaderboard contract.
///
/// | Code | Variant          | Meaning                                        |
/// |------|------------------|------------------------------------------------|
/// |  1   | AlreadyInitialized | `initialize` called more than once           |
/// |  2   | Unauthorized     | Caller is not registered as a data source     |
/// |  3   | NotInitialized   | Contract has not been initialized yet          |
/// |  4   | InvalidResult    | Result is not a recognised variant             |
/// |  5   | InvalidRange     | `limit` is zero or the page offset is past the end |
/// |  6   | ContractPaused   | Result recording is paused                     |
/// |  7   | InvalidAsset     | Asset is not a contract implementing token decimals |
/// |  8   | TooManyPlayers   | Maximum indexed population has been reached   |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// [E001] The contract has already been initialized.
    AlreadyInitialized = 1,

    /// [E002] The caller is not a registered data source.
    Unauthorized = 2,

    /// [E003] The contract has not been initialized.
    NotInitialized = 3,

    /// [E004] The supplied result is not a recognised variant.
    InvalidResult = 4,

    /// [E005] `limit` was zero, or `offset` was past the end of the results.
    InvalidRange = 5,

    /// [E006] Result recording is paused.
    ContractPaused = 6,

    /// The supplied asset is not a deployed token contract.
    InvalidAsset = 7,

    /// The leaderboard has reached its declared maximum population.
    TooManyPlayers = 8,
}

/// The outcome of a single match, as reported by the escrow contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchOutcome {
    /// Player 1 won the match.
    Player1Won,
    /// Player 2 won the match.
    Player2Won,
    /// The match ended in a draw; both players had their stake returned.
    Draw,
}

/// A player's global counters and current earnings denomination.
///
/// `wins + losses + draws` is the number of completed matches that player has
/// taken part in. `earnings` accumulates in the `token` denomination and resets
/// when a later win uses another token. Use the per-asset leaderboard for a
/// player's separate totals across multiple tokens.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerStats {
    /// Completed matches won.
    pub wins: u32,
    /// Completed matches lost.
    pub losses: u32,
    /// Completed matches drawn.
    pub draws: u32,
    /// Amount won in `token`'s smallest unit since the latest denomination change.
    pub earnings: i128,
    /// Token for the current `earnings` amount.
    pub token: Address,
}

impl PlayerStats {
    /// A zeroed record for a player who has not been seen.
    ///
    /// Written by hand rather than derived from `Default` because `Address` has
    /// no `Default` impl. Returning a zeroed record (rather than `None`) keeps
    /// `get_stats` total — a caller never has to handle an absent player.
    pub fn empty(token: &Address) -> Self {
        PlayerStats {
            wins: 0,
            losses: 0,
            draws: 0,
            earnings: 0,
            token: token.clone(),
        }
    }

    /// Total completed matches this player took part in.
    pub fn matches_played(&self) -> u32 {
        self.wins + self.losses + self.draws
    }
}

/// One row of [`get_leaderboard`](crate::LeaderboardContract::get_leaderboard).
///
/// The player address is carried in the row rather than looked up separately so
/// a caller rendering a page does not need one RPC round-trip per row.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaderboardEntry {
    /// The player's Stellar address.
    pub player: Address,
    /// The player's lifetime record.
    pub stats: PlayerStats,
}

/// Storage keys.
///
/// | Key                  | Tier       | Contents                              |
/// |----------------------|------------|---------------------------------------|
/// | `Admin`              | Instance   | Address permitted to pause and re-key |
/// | `Paused`             | Instance   | Whether recording results is blocked  |
/// | `Stats(Address)`     | Persistent | [`PlayerStats`] for one address       |
/// | `ResultCount`        | Instance   | Number of results recorded so far     |
/// | `Sources(Address)`   | Instance   | Whether an address may submit results |
/// | `Roster`             | Instance   | Every address that has a stats entry  |
/// | `RankedRoster`       | Instance   | Global rank-ordered address index     |
/// | `AssetRoster(Address)` | Persistent | Rank-ordered addresses for one asset  |
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The administrator.
    Admin,
    /// Whether result recording is paused.
    Paused,
    /// A player's [`PlayerStats`].
    Stats(Address),
    /// A player's per-asset record.
    AssetStats(Address, Address),
    /// How many results have been recorded, used to bound the leaderboard.
    ResultCount,
    /// Whether `Address` is authorised to submit results.
    Sources(Address),
    /// Every address that has a [`PlayerStats`] entry.
    Roster,
    /// Rank-sorted global player index.
    RankedRoster,
    /// Rank-sorted player index for one asset.
    AssetRoster(Address),
}

/// Maximum number of rows a single `get_leaderboard` call may return.
///
/// A read that returns an unbounded `Vec` lets one caller force a read that
/// costs more as the contract grows, and the response must fit in a single
/// transaction's return budget. Callers page with `offset` instead.
pub const MAX_PAGE_SIZE: u32 = 50;

/// Maximum distinct players stored by this contract. The maintained rank
/// indexes cap write work and the amount of state a leaderboard can occupy.
pub const MAX_PLAYERS: u32 = 256;

/// How many ledgers a [`PlayerStats`] entry lives once written.
///
/// Matches the escrow's match retention so a player's record outlives every
/// match that contributes to it. A leaderboard that expires before its matches
/// would report fewer games than actually happened.
pub const STATS_TTL_LEDGERS: u32 = 518_400;
