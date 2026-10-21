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

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, Symbol, Vec};

const INSTANCE_LIFETIME_THRESHOLD: u32 = STATS_TTL_LEDGERS;
const INSTANCE_BUMP_AMOUNT: u32 = STATS_TTL_LEDGERS;

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
        env.storage()
            .instance()
            .set(&DataKey::Roster, &Vec::<Address>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::RankedRoster, &Vec::<Address>::new(&env));
        Self::bump_instance_ttl(&env);

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
    pub fn add_source(env: Env, source: Address, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;

        source.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Sources(source.clone()), &true);
        Self::bump_instance_ttl(&env);
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
        env.storage().instance().remove(&DataKey::Sources(source));
        Self::bump_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "admin"), symbol_short!("src_del")),
            caller,
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
        Self::bump_instance_ttl(&env);
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
        // A successful decimals call verifies that this is a deployed
        // contract implementing the Soroban token interface.
        let asset = token::Client::new(&env, &token);
        if !matches!(asset.try_decimals(), Ok(Ok(_))) {
            return Err(Error::InvalidAsset);
        }
        caller.require_auth();

        Self::ensure_population_capacity(&env, &player1, &player2)?;

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
                if w_stats.token == token {
                    w_stats.earnings += payout;
                } else {
                    w_stats.earnings = payout;
                }
                w_stats.token = token.clone();
                Self::store_stats(&env, w, &w_stats);
                Self::update_asset_stats(&env, w, &token, true, false, payout);

                let mut l_stats = Self::load_stats(&env, l);
                l_stats.losses += 1;
                Self::store_stats(&env, l, &l_stats);
                Self::update_asset_stats(&env, l, &token, false, false, 0);
            }
            _ => {
                let mut p1 = Self::load_stats(&env, &player1);
                p1.draws += 1;
                Self::store_stats(&env, &player1, &p1);
                Self::update_asset_stats(&env, &player1, &token, false, true, 0);

                let mut p2 = Self::load_stats(&env, &player2);
                p2.draws += 1;
                Self::store_stats(&env, &player2, &p2);
                Self::update_asset_stats(&env, &player2, &token, false, true, 0);
            }
        }

        // Both sides are added unconditionally: even a player who only ever
        // loses or draws needs a roster entry to be ranked.
        Self::add_to_roster(&env, &player1);
        Self::add_to_roster(&env, &player2);
        Self::refresh_global_rank(&env, &player1);
        Self::refresh_global_rank(&env, &player2);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ResultCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::ResultCount, &count.saturating_add(1));
        Self::bump_instance_ttl(&env);

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

    /// Return a page of the global leaderboard, ranked by wins.
    ///
    /// Paging is `offset`-based. `limit` is capped at [`MAX_PAGE_SIZE`], so a
    /// caller asking for more gets one full page rather than a response too
    /// large to return in a single transaction.
    ///
    /// ## Ranking and its limits
    ///
    /// Rows are ordered by wins descending, then address ascending. Earnings
    /// are excluded because records may use different assets.
    ///
    /// Use [`get_asset_leaderboard`](Self::get_asset_leaderboard) to rank
    /// earnings within one asset.
    ///
    /// The sorted index is updated on writes and capped at [`MAX_PLAYERS`].
    /// Reads fetch stats only for the requested page. Only players with at
    /// least one completed match appear. A caller paging
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

        let ranked: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::RankedRoster)
            .unwrap_or_else(|| Vec::new(&env));
        if offset > 0 && offset >= ranked.len() {
            return Err(Error::InvalidRange);
        }

        let end = core::cmp::min(ranked.len(), offset.saturating_add(limit));
        let mut out: Vec<LeaderboardEntry> = Vec::new(&env);
        let mut i = offset;
        while i < end {
            let player = ranked.get(i).unwrap();
            let stats = Self::load_stats(&env, &player);
            out.push_back(LeaderboardEntry { player, stats });
            i += 1;
        }
        Ok(out)
    }

    /// Return an independently ranked page for one token. Earnings are
    /// compared only with earnings in this same token, in its smallest unit.
    pub fn get_asset_leaderboard(
        env: Env,
        asset: Address,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<LeaderboardEntry>, Error> {
        if limit == 0 {
            return Err(Error::InvalidRange);
        }
        let limit = core::cmp::min(limit, MAX_PAGE_SIZE);
        let ranked: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AssetRoster(asset.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        if offset > 0 && offset >= ranked.len() {
            return Err(Error::InvalidRange);
        }
        let end = core::cmp::min(ranked.len(), offset.saturating_add(limit));
        let mut out = Vec::new(&env);
        let mut i = offset;
        while i < end {
            let player = ranked.get(i).unwrap();
            let stats = Self::load_asset_stats(&env, &player, &asset);
            out.push_back(LeaderboardEntry { player, stats });
            i += 1;
        }
        Ok(out)
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

    fn load_asset_stats(env: &Env, player: &Address, asset: &Address) -> PlayerStats {
        env.storage()
            .persistent()
            .get(&DataKey::AssetStats(player.clone(), asset.clone()))
            .unwrap_or_else(|| PlayerStats::empty(asset))
    }

    fn update_asset_stats(
        env: &Env,
        player: &Address,
        asset: &Address,
        win: bool,
        draw: bool,
        payout: i128,
    ) {
        let key = DataKey::AssetStats(player.clone(), asset.clone());
        let mut stats = Self::load_asset_stats(env, player, asset);
        if win {
            stats.wins += 1;
            stats.earnings += payout;
        } else if draw {
            stats.draws += 1;
        } else {
            stats.losses += 1;
        }
        env.storage().persistent().set(&key, &stats);
        env.storage()
            .persistent()
            .extend_ttl(&key, STATS_TTL_LEDGERS, STATS_TTL_LEDGERS);
        let roster_key = DataKey::AssetRoster(asset.clone());
        let mut ranked: Vec<Address> = env
            .storage()
            .persistent()
            .get(&roster_key)
            .unwrap_or_else(|| Vec::new(env));
        for idx in 0..ranked.len() {
            if ranked.get(idx).unwrap() == *player {
                let _ = ranked.remove(idx);
                break;
            }
        }
        let mut rank = 0;
        while rank < ranked.len()
            && !Self::asset_ranks_after(env, &ranked.get(rank).unwrap(), player, asset)
        {
            rank += 1;
        }
        ranked.insert(rank, player.clone());
        env.storage().persistent().set(&roster_key, &ranked);
        env.storage()
            .persistent()
            .extend_ttl(&roster_key, STATS_TTL_LEDGERS, STATS_TTL_LEDGERS);
    }

    fn asset_ranks_after(env: &Env, a: &Address, b: &Address, asset: &Address) -> bool {
        let a_stats = Self::load_asset_stats(env, a, asset);
        let b_stats = Self::load_asset_stats(env, b, asset);
        if a_stats.wins != b_stats.wins {
            return a_stats.wins < b_stats.wins;
        }
        if a_stats.earnings != b_stats.earnings {
            return a_stats.earnings < b_stats.earnings;
        }
        a > b
    }

    fn ensure_population_capacity(
        env: &Env,
        player1: &Address,
        player2: &Address,
    ) -> Result<(), Error> {
        let roster: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Roster)
            .unwrap_or_else(|| Vec::new(env));
        let has1 = roster.contains(player1);
        let has2 = roster.contains(player2);
        let additions = ((!has1) as u32) + ((!has2 && player1 != player2) as u32);
        if roster.len().saturating_add(additions) > MAX_PLAYERS {
            return Err(Error::TooManyPlayers);
        }
        Ok(())
    }

    fn refresh_global_rank(env: &Env, player: &Address) {
        let mut ranked: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::RankedRoster)
            .unwrap_or_else(|| Vec::new(env));
        for idx in 0..ranked.len() {
            if ranked.get(idx).unwrap() == *player {
                let _ = ranked.remove(idx);
                break;
            }
        }
        let mut rank = 0;
        while rank < ranked.len()
            && !Self::global_ranks_after(env, &ranked.get(rank).unwrap(), player)
        {
            rank += 1;
        }
        ranked.insert(rank, player.clone());
        env.storage()
            .instance()
            .set(&DataKey::RankedRoster, &ranked);
    }

    fn global_ranks_after(env: &Env, a: &Address, b: &Address) -> bool {
        let a_stats = Self::load_stats(env, a);
        let b_stats = Self::load_stats(env, b);
        if a_stats.wins != b_stats.wins {
            return a_stats.wins < b_stats.wins;
        }
        a > b
    }

    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
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
            if roster.get(i).unwrap() == *player {
                return;
            }
            i += 1;
        }

        roster.push_back(player.clone());
        env.storage().instance().set(&DataKey::Roster, &roster);
    }
}

#[cfg(test)]
mod tests;
