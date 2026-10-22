//! Policy constants for the tournament bracket contract.
//!
//! The ledger durations and identifier limits come from
//! [`smile4money_common::constants`] so this contract cannot drift away from the
//! escrow and oracle contracts. `lib.rs` does `pub use constants::*`, which keeps
//! `crate::MATCH_TTL_LEDGERS` resolvable from the unit tests.
//!
//! # Sources
//!
//! - Stellar ledger close time (~5 s average) and ledger lifecycle:
//!   <https://developers.stellar.org/docs/encyclopedia/security-and-property-guides/ledger-anatomy>
//! - `extend_ttl` threshold / extend-to semantics:
//!   <https://developers.stellar.org/docs/build/guides/storage/extend-bump-lifetimes>
//! - Minimum account balance / base reserve:
//!   <https://developers.stellar.org/docs/encyclopedia/security-and-property-guides/minimum-account-balance>
//! - Bracket shape, seeding and prize accounting:
//!   ADR-003 (`docs/adr/003-tournament-bracket.md`)

pub use smile4money_common::constants::{
    DEFAULT_TIMEOUT_LEDGERS, LEDGERS_PER_WEEK, MATCH_TTL_LEDGERS, MAX_GAME_ID_LEN,
    SECONDS_PER_LEDGER, TIMEOUT_LEDGERS,
};

/// Smallest supported field size.
///
/// **Source:** ADR-003 §2. A bracket needs at least one match, so two entrants is
/// the floor. There is no meaningful "tournament" below this.
pub const MIN_PLAYERS: u32 = 2;

/// Largest supported field size, i.e. 6 rounds of single elimination.
///
/// **Source:** ADR-003, "Negative consequences". Chosen so that the whole bracket
/// (N−1 = 63 nodes) is cheap enough to fit comfortably in one contract's
/// resource budget, and so a single tournament cannot lock an unbounded balance.
/// Larger fields would need a different data structure than a flat node list.
pub const MAX_PLAYERS: u32 = 64;

/// Smallest permitted entry fee, in the smallest unit of the tournament token.
///
/// **Source:** policy decided by this repository; prevents economically
/// meaningless zero-fee tournaments, mirroring `MIN_STAKE` in the escrow
/// contract (`docs/issue-3-zero-stake-guard.md`).
pub const MIN_ENTRY_FEE: i128 = 1;

/// Largest permitted prize pool (`entry_fee × player_count`), in the smallest
/// unit of the tournament token.
///
/// **Source:** policy decided by this repository. Note this is deliberately a
/// *pool* bound rather than reusing the escrow contract's `MAX_STAKE`, because a
/// tournament's exposure scales with the field size: the same per-player fee
/// that is safe in a 1v1 match is a 64x larger pot in a full bracket. Capping
/// the pot directly is what actually bounds the contract's liability.
/// `1_000_000_000_000` stroops = 100 000 XLM.
pub const MAX_PRIZE_POOL: i128 = 1_000_000_000_000;

/// Instance-storage TTL threshold: the same 30-day window as
/// [`MATCH_TTL_LEDGERS`].
///
/// **Source:** <https://developers.stellar.org/docs/build/guides/storage/extend-bump-lifetimes>
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = MATCH_TTL_LEDGERS;

/// Number of ledgers instance-storage entries are extended to.
///
/// **Source:** the same 30-day window as [`INSTANCE_LIFETIME_THRESHOLD`], so the
/// instance counter can be renewed for the same duration as persistent records.
/// Each entry still has an independent TTL based on its last extension.
pub const INSTANCE_BUMP_AMOUNT: u32 = MATCH_TTL_LEDGERS;

/// Reserve buffer (in stroops) the contract must always retain, so that a payout
/// or refund can never drop the backing account below Stellar's minimum account
/// balance — which would make the underlying `transfer` abort and leave the
/// tournament state machine inconsistent.
///
/// **Source:** Stellar minimum account balance
/// (<https://developers.stellar.org/docs/encyclopedia/security-and-property-guides/minimum-account-balance>)
/// plus the base-reserve value in `docs/deployment.md`. The 0.5 XLM of slack on
/// top of the 1 XLM minimum is a policy choice, matching the escrow contract.
/// `15_000_000` stroops = 1.5 XLM.
pub const ESCROW_RESERVE_BUFFER_STROOPS: i128 = 15_000_000;
