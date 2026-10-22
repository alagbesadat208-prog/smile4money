use soroban_sdk::contracterror;

pub use smile4money_common::SharedError;

/// Errors returned by the tournament bracket contract.
///
/// Error codes are **stable on-chain identifiers**. Do not renumber an existing
/// variant — doing so breaks any client that inspects the raw code.
///
/// Codes 1–28 deliberately match the escrow contract (`contracts/escrow/src/errors.rs`)
/// for concepts that mean the same thing in both, so a shared client library can
/// handle them uniformly. Codes 30 and above are new to the tournament contract.
///
/// # Error code table
///
/// | Code | Variant               | Meaning                                                       |
/// |------|-----------------------|---------------------------------------------------------------|
/// |  1   | TournamentNotFound    | No tournament exists for the given ID                         |
/// |  2   | AlreadyFunded         | The entrant has already paid their entry fee                 |
/// |  4   | Unauthorized          | Caller is not permitted to perform this action               |
/// |  5   | InvalidState          | Operation is not valid in the tournament's current state      |
/// |  7   | AlreadyInitialized    | Contract has already been initialized                         |
/// |  8   | Overflow              | A counter would exceed its integer range                      |
/// | 10   | InvalidAmount         | Amount must be greater than zero                             |
/// | 11   | InvalidGameId         | game_id is empty, too long, or has disallowed characters      |
/// | 15   | TransferFailed        | Token transfer failed                                         |
/// | 23   | InvalidAdmin          | The admin address is invalid (zero address)                   |
/// | 24   | StakeTooLow           | `entry_fee` is below `MIN_ENTRY_FEE`                          |
/// | 25   | StakeTooHigh          | The resulting prize pool exceeds `MAX_PRIZE_POOL`             |
/// | 26   | InsufficientReserve   | Payout would drop the contract below the Stellar base reserve  |
/// | 27   | InvalidAddress        | An entrant address is invalid (zero address / burn address)   |
/// | 30   | InvalidPlayerCount    | `player_count` is not a power of two in [2, 64]               |
/// | 31   | DuplicatePlayer       | The same address appears twice in `players`                   |
/// | 32   | PlayerNotRegistered   | The caller is not an entrant in this tournament               |
/// | 33   | NodeNotFound          | No bracket node at (round, index)                            |
/// | 34   | InvalidNodeStatus     | Node is not in a state that allows this operation             |
/// | 35   | WinnerNotInMatch      | The reported winner is not one of the node's two entrants     |
/// | 36   | TournamentInProgress  | At least one match has been decided                           |
/// | 37   | TournamentFinished    | Tournament is completed or cancelled                          |
/// | 38   | TimeoutNotReached     | `TIMEOUT_LEDGERS` have not yet elapsed                        |
/// | 39 | SettlementNotFound | No deferred allocation exists (including legacy paid records) |
/// | 40 | NothingToClaim | Entrant has no funded entitlement |
/// | 41 | AlreadyClaimed | This entitlement has already been paid |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// [E001] No tournament exists for the given `tournament_id`.
    TournamentNotFound = 1,

    /// [E002] The entrant has already paid their entry fee for this tournament.
    AlreadyFunded = 2,

    /// [E004] Caller is not the registered oracle / admin, or is not an entrant.
    Unauthorized = 4,

    /// [E005] Operation is not valid in the tournament's current state.
    InvalidState = 5,

    /// [E007] `initialize` has already been called.
    AlreadyInitialized = 7,

    /// [E008] A counter would exceed its integer range.
    Overflow = 8,

    /// [E010] Amount must be a positive integer greater than zero.
    InvalidAmount = 10,

    /// [E011] `game_id` is empty, exceeds `MAX_GAME_ID_LEN`, or contains
    /// characters outside `[A-Za-z0-9_-]`.
    InvalidGameId = 11,

    /// [E015] Token transfer failed.
    TransferFailed = 15,

    /// [E023] The admin address is invalid (e.g. zero address).
    InvalidAdmin = 23,

    /// [E024] `entry_fee` is below `MIN_ENTRY_FEE`.
    StakeTooLow = 24,

    /// [E025] `entry_fee × player_count` exceeds `MAX_PRIZE_POOL`.
    StakeTooHigh = 25,

    /// [E026] The contract's token balance cannot cover the payout while
    /// retaining `ESCROW_RESERVE_BUFFER_STROOPS`.
    InsufficientReserve = 26,

    /// [E027] An entrant address is invalid (zero address / burn address).
    InvalidAddress = 27,

    /// [E030] `player_count` is not a power of two, or is outside [2, 64].
    InvalidPlayerCount = 30,

    /// [E031] The same address appears more than once in `players`.
    DuplicatePlayer = 31,

    /// [E032] The caller is not one of the tournament's entrants.
    PlayerNotRegistered = 32,

    /// [E033] No bracket node exists at the given (round, index).
    NodeNotFound = 33,

    /// [E034] The node is not in a state that allows the requested operation.
    InvalidNodeStatus = 34,

    /// [E035] The reported winner is not one of the node's two entrants.
    WinnerNotInMatch = 35,

    /// [E036] The operation requires the tournament to still be in `Registration`.
    TournamentInProgress = 36,

    /// [E037] The tournament is already `Completed` or `Cancelled`.
    TournamentFinished = 37,

    /// [E038] `TIMEOUT_LEDGERS` have not elapsed since the tournament was created.
    TimeoutNotReached = 38,
    /// No allocation exists, including already-paid legacy records.
    SettlementNotFound = 39,
    /// The entrant did not fund the tournament or has no allocation.
    NothingToClaim = 40,
    /// This allocation has already been paid.
    AlreadyClaimed = 41,
}

/// Convert a [`SharedError`] into a tournament [`Error`].
///
/// This enables the `?` operator when calling helpers that return
/// `Result<_, SharedError>`, propagating them as the equivalent local variant.
impl From<SharedError> for Error {
    fn from(e: SharedError) -> Self {
        match e {
            SharedError::Unauthorized => Error::Unauthorized,
            SharedError::AlreadyInitialized => Error::AlreadyInitialized,
            SharedError::InvalidAmount => Error::InvalidAmount,
            SharedError::InvalidGameId => Error::InvalidGameId,
            SharedError::TransferFailed => Error::TransferFailed,
            SharedError::InvalidAdmin => Error::InvalidAdmin,
        }
    }
}
