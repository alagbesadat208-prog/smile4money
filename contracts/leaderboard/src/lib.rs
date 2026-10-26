//! # Leaderboard Contract
//!
//! Tracks lifetime win / loss / draw records and total earnings per Stellar
//! address, so a frontend can render a ranked leaderboard without replaying
//! the escrow's entire history off-chain.
//!
//! ## How results get in
//!
//! The escrow contract emits an event when a match completes. The leaderboard
//! cannot subscribe to events â€” Soroban contracts cannot observe other
//! contracts' events â€” so a **trusted relayer** (the existing oracle service)
//! reads the payout event and calls
//! [`record_result`](LeaderboardContract::record_result).
//!
//! The relayer is registered as a data source at
//! [`initialize`](LeaderboardContract::initialize) or later via
//! [`add_source`](LeaderboardContract::add_source). This is deliberately *not*
//! "anyone can submit": a leaderboard that any caller could write to is not a
//! leaderboard, it is a graffiti wall. Forgetting a result is recoverable
//! (replay it); corrupting one is not.
//!
//! ## Why the relayer is the trust boundary
//!
//! The leaderboard is a **display** contract. It escrows nothing and moves no
//! funds, so a dishonest relayer can only produce a wrong ranking â€” it cannot
//! steal anything. That keeps the consequence of compromising this contract
//! small, which is the right trade for a feature whose only job is a leaderboard
//! page. Payout correctness is unaffected: it lives in the escrow contract and
//! is already final by the time this contract hears about it.
//!
//! ## Identity and edge cases
//!
//! A player is identified by the address that actually escrowed, which is the
//! Stellar address, not a platform username. Usernames are reassignable on both
//! Lichess and Chess.com; tying a permanent record to one would let a new
//! account inherit an old player's history.
//!
//! Every recorded result must name **two distinct** players. A result where both
//! sides are the same address is rejected rather than counted, because it would
//! hand a player a free win and a loss simultaneously and inflate
//! `matches_played`.

#![no_std]

mod types;

pub use types::*;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};

#[contract]
pub struct LeaderboardContract;

#[contractimpl]
impl LeaderboardContract {
    /// Register the administrator and the first data source.
    ///
    /// # Errors
    ///
    /// * [`Error::AlreadyInitialized`] â€” called more than once.
    pub fn initialize(env: Env, admin: Address, source: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        admin.require_auth();
        source.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::ResultCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::Sources(source.clone()), &true);

        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("init")),
            (admin, source),
        );
        Ok(())
    }

    /// Authorise an additional address to record results â€” admin only.
    ///
    /// Used when more than one relayer should be able to submit, for example
    /// during a failover.
    /// Returns [`Error::DuplicateSource`] if already authorised, without writing
    /// storage or emitting an event. Grant/revoke events use topics
    /// `(admin, src_add | src_del)` and data `(source, caller)`.
    pub fn add_source(env: Env, source: Address, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;

        if Self::is_source(env.clone(), source.clone()) {
            return Err(Error::DuplicateSource);
        }
        source.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Sources(source.clone()), &true);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("src_add")),
            (source, caller),
        );
        Ok(())
    }

    /// Revoke a data source's permission to record results â€” admin only.
    ///
    /// Results already recorded are untouched; this only stops future writes.
    pub fn remove_source(env: Env, source: Address, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;

        if !env
            .storage()
            .instance()
            .has(&DataKey::Sources(source.clone()))
        {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .instance()
            .remove(&DataKey::Sources(source.clone()));
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("src_del")),
            (source, caller),
        );
        Ok(())
    }

    /// Return whether an address may record results.
    pub fn is_source(env: Env, source: Address) -> bool {
        env.storage().instance().has(&DataKey::Sources(source))
    }

    /// Stop or resume recording results â€” admin only.
    ///
    /// The relayer keeps calling `record_result` while paused; calls are
    /// rejected rather than queued. Pausing exists so a relayer that has
    /// started writing nonsense can be stopped without unregistering it and
    /// rebuilding state.
    pub fn set_paused(env: Env, paused: bool, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("pause_set")),
            (paused, caller),
        );
        Ok(())
    }

    /// Return whether result recording is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Record the outcome of one completed match.
    ///
    /// Updates the win / loss / draw counters of both players, and on a decisive
    /// result credits the winner with `payout`. The token is recorded alongside
    /// `earnings` because amounts in different tokens are not comparable.
    ///
    /// A draw records a draw for both players and credits nobody: the escrow
    /// returned each player's own stake, so no one was paid and treating a
    /// refund as earnings would inflate the leaderboard for players who draw
    /// often.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — caller is not a registered data source.
    /// * [`Error::ContractPaused`] — recording is paused.
    /// * [`Error::InvalidResult`] — `player1 == player2`.
    pub fn record_result(
        env: Env,
        player1: Address,
        player2: Address,
        outcome: MatchOutcome,
        payout: i128,
        token: Address,
        caller: Address,
    ) -> Result<(), Error> {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Sources(caller.clone()))
        {
            return Err(Error::Unauthorized);
        }
        if Self::is_paused(env.clone()) {
            return Err(Error::ContractPaused);
        }
        // A self-match would credit a player a win and a loss at once, and
        // inflate `matches_played` for both slots.
        if player1 == player2 {
            return Err(Error::InvalidResult);
        }
        if payout < 0 {
            return Err(Error::InvalidResult);
        }
        caller.require_auth();

        // `MatchOutcome` is not `Copy`, so the outcome is matched once to decide
        // which side is credited, rather than compared and matched separately.
        let (winner, loser) = match &outcome {
            MatchOutcome::Player1Won => (Some(&player1), Some(&player2)),
            MatchOutcome::Player2Won => (Some(&player2), Some(&player1)),
            // A draw credits nobody and loses nobody; both sides just get a draw.
            MatchOutcome::Draw => (None, None),
        };

        match (winner, loser) {
            (Some(w), Some(l)) => {
                let mut w_stats = Self::load_stats(&env, w);
                w_stats.wins += 1;
                w_stats.earnings += payout;
                w_stats.token = token.clone();
                Self::store_stats(&env, w, &w_stats);

                let mut l_stats = Self::load_stats(&env, l);
                l_stats.losses += 1;
                Self::store_stats(&env, l, &l_stats);
            }
            _ => {
                let mut p1 = Self::load_stats(&env, &player1);
                p1.draws += 1;
                Self::store_stats(&env, &player1, &p1);

                let mut p2 = Self::load_stats(&env, &player2);
                p2.draws += 1;
                Self::store_stats(&env, &player2, &p2);
            }
        }

        // Both sides are added unconditionally: even a player who only ever
        // loses or draws needs a roster entry to be ranked.
        Self::add_to_roster(&env, &player1);
        Self::add_to_roster(&env, &player2);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ResultCount)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::ResultCount,
            &count.checked_add(1).ok_or(Error::ResultCountOverflow)?,
        );

        env.events().publish(
            (Symbol::new(&env, "result"), symbol_short!("recorded")),
            (player1, player2, outcome, payout, token, count),
        );
        Ok(())
    }

    /// Read one player's record. Returns zeros for a player never seen.
    pub fn get_stats(env: Env, player: Address) -> PlayerStats {
        Self::load_stats(&env, &player)
    }

    /// Return how many results have been recorded.
    pub fn result_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ResultCount)
            .unwrap_or(0)
    }

    /// Read the admin address — used by off-chain tooling to build a
    /// `record_result` transaction signed by the relayer.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Return a page of the leaderboard, ranked by wins then earnings.
    ///
    /// Paging is `offset`-based. `limit` is capped at [`MAX_PAGE_SIZE`], so a
    /// caller asking for more gets one full page rather than a response too
    /// large to return in a single transaction.
    ///
    /// ## Ranking and its limits
    ///
    /// Rows are ordered by **wins** descending, then `earnings` descending,
    /// then address ascending as a tie-break. The final tie-break matters: two
    /// players with identical records must come back in a stable order, or
    /// paging would show duplicates on one page and skip rows on the next.
    ///
    /// The earnings tie-break is only meaningful **within a single token** —
    /// a raw stroop count of USDC and one of XLM are not comparable numbers.
    /// The `token` field is returned on every row so a caller can group or
    /// label by currency rather than silently adding unlike units together.
    ///
    /// Only players with at least one completed match appear. A caller paging
    /// to the end gets a short page rather than an error, which is the normal
    /// "no more results" signal for a paginated read.
    ///
    /// # Errors
    ///
    /// * [`Error::InvalidRange`] — `limit` is zero, or `offset` is beyond the
    ///   end of the results.
    pub fn get_leaderboard(
        env: Env,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<LeaderboardEntry>, Error> {
        if limit == 0 {
            return Err(Error::InvalidRange);
        }
        let limit = if limit > MAX_PAGE_SIZE {
            MAX_PAGE_SIZE
        } else {
            limit
        };

        // A player is "on the board" once they have completed a match, so an
        // address that has never played cannot occupy a slot.
        //
        // The roster is an instance-tier `Vec<Address>` of everyone who has
        // been recorded, and is the only thing that has to be enumerated here —
        // iterating persistent storage is not possible, so without a roster
        // there would be no way to discover who exists.
        let roster: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Roster)
            .unwrap_or_else(|| Vec::new(&env));

        let mut ranked: Vec<(Address, PlayerStats)> = Vec::new(&env);
        let roster_len = roster.len();
        let mut idx = 0u32;
        while idx < roster_len {
            let player = roster.get_unchecked(idx);
            let stats = Self::load_stats(&env, &player);
            if stats.matches_played() > 0 {
                ranked.push_back((player, stats));
            }
            idx += 1;
        }

        // Insertion sort, descending by (wins, earnings) with an ascending
        // address tie-break.
        //
        // Why not sort in Rust and worry about cost? Because `Vec::sort` is
        // unavailable in `no_std` for Soroban's ordered collections, and
        // because the board is expected to be small — a page of 50 out of the
        // players who have actually wagered. Insertion sort is O(n^2) in the
        // worst case, which is the wrong shape for a large board; the honest
        // framing is that this is correct and adequate at current scale, and
        // the thing to revisit first if the board grows.
        let len = ranked.len();
        for i in 1..len {
            let mut j = i;
            while j > 0 && Self::ranks_after(&ranked.get_unchecked(j - 1), &ranked.get_unchecked(j))
            {
                let prev = ranked.get_unchecked(j - 1);
                let cur = ranked.get_unchecked(j);
                ranked.set(j, prev);
                ranked.set(j - 1, cur);
                j -= 1;
            }
        }

        if offset > 0 && offset >= ranked.len() {
            return Err(Error::InvalidRange);
        }

        let end = core::cmp::min(ranked.len(), offset.saturating_add(limit));
        let mut out: Vec<LeaderboardEntry> = Vec::new(&env);
        let mut i = offset;
        while i < end {
            let (player, stats) = ranked.get_unchecked(i);
            out.push_back(LeaderboardEntry { player, stats });
            i += 1;
        }
        Ok(out)
    }

    /// Read a page pinned to a ranking revision (the successful result count).
    /// Pass `None` for the first page and reuse its `snapshot` for every later
    /// page, including backward navigation. A new result invalidates that
    /// revision: [`Error::SnapshotChanged`] requires restarting at offset zero.
    /// No historical rows are retained. Rejecting a stale revision atomically
    /// prevents clients from combining rows from different ranking versions.
    /// Ordering and range limits match [`Self::get_leaderboard`].
    pub fn get_ranked_page(
        env: Env,
        limit: u32,
        offset: u32,
        snapshot: Option<u32>,
    ) -> Result<LeaderboardPage, Error> {
        let current = Self::result_count(env.clone());
        if snapshot.is_some_and(|expected| expected != current) {
            return Err(Error::SnapshotChanged);
        }
        if snapshot.is_none() && offset != 0 {
            return Err(Error::InvalidRange);
        }
        let entries = Self::get_leaderboard(env, limit, offset)?;
        Ok(LeaderboardPage {
            snapshot: current,
            entries,
        })
    }

    /// Read the admin address, panicking-free helper for internal use.
    fn require_admin(env: &Env, caller: &Address) -> Result<Address, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if *caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Ok(admin)
    }

    /// Load a player's stats, or a zeroed record if they have never played.
    fn load_stats(env: &Env, player: &Address) -> PlayerStats {
        env.storage()
            .persistent()
            .get(&DataKey::Stats(player.clone()))
            .unwrap_or_else(|| PlayerStats::empty(player))
    }

    /// Write a player's stats and bump their TTL.
    fn store_stats(env: &Env, player: &Address, stats: &PlayerStats) {
        env.storage()
            .persistent()
            .set(&DataKey::Stats(player.clone()), stats);
        env.storage().persistent().extend_ttl(
            &DataKey::Stats(player.clone()),
            STATS_TTL_LEDGERS,
            STATS_TTL_LEDGERS,
        );
    }

    /// Add `player` to the roster if they are not on it yet.
    ///
    /// The roster is a `Vec`, so membership is a linear scan. That is fine
    /// because a result touches at most two players, and a player appears in
    /// the roster exactly once — the check is O(roster) per *new* player, not
    /// per result.
    fn add_to_roster(env: &Env, player: &Address) {
        let mut roster: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Roster)
            .unwrap_or_else(|| Vec::new(env));

        let len = roster.len();
        let mut i = 0u32;
        while i < len {
            if roster.get_unchecked(i) == *player {
                return;
            }
            i += 1;
        }

        roster.push_back(player.clone());
        env.storage().instance().set(&DataKey::Roster, &roster);
    }

    /// Whether `a` should sort after `b` — i.e. `a` ranks lower.
    ///
    /// Ordering is wins descending, then earnings descending, then address
    /// ascending. The address tie-break is not cosmetic: without it, two
    /// players with identical records have no defined relative order, and
    /// `get_leaderboard` paging would show the same row twice across page
    /// boundaries and silently skip another.
    fn ranks_after(a: &(Address, PlayerStats), b: &(Address, PlayerStats)) -> bool {
        if a.1.wins != b.1.wins {
            return a.1.wins < b.1.wins;
        }
        if a.1.earnings != b.1.earnings {
            return a.1.earnings < b.1.earnings;
        }
        a.0 > b.0
    }
}

#[cfg(test)]
mod tests;
