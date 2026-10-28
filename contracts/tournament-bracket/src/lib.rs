//! # Tournament bracket
//!
//! A single-elimination bracket for a power-of-two field, as specified in
//! [ADR-003](../../docs/adr/003-tournament-bracket.md).
//!
//! An entrant pays their entry fee exactly once. Winners advance from round to
//! round on oracle result submission, and the champion receives the entire prize
//! pool (`entry_fee × player_count`) when the final is decided.
//!
//! ## Bracket shape
//!
//! ```text
//!  4 entrants, seeded [s0 s3] [s1 s2]
//!
//!  round 0                 round 1 (final)
//!  ┌───────────┐           ┌───────────┐
//!  │ 0  s0 ─┬──┐           │           │
//!  │         │  ├─ winner ─┤  0   ─┬──┘
//!  │ 0  s3 ─┴──┘           │        │
//!  └───────────┘           │        │
//!  ┌───────────┐           │        │
//!  │ 1  s1 ─┬──┐           │        │
//!  │         │  ├─ winner ─┤        ├── champion
//!  │ 1  s2 ─┴──┘           │        │
//!  └───────────┘           │        │
//!                         └───────────┘
//! ```
//!
//! ## Related documentation
//!
//! - Design rationale: [`docs/adr/003-tournament-bracket.md`](../../docs/adr/003-tournament-bracket.md)
//! - Single-match escrow, which this contract generalises:
//!   [`docs/api-reference.md`](../../docs/api-reference.md)
//! - Oracle architecture: [`docs/oracle.md`](../../docs/oracle.md)

#![no_std]

mod constants;
mod errors;
mod types;

pub use constants::*;

use errors::Error;
use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, String, Symbol, Vec};
use types::{DataKey, MatchNode, NodeStatus, Tournament, TournamentState};

/// Return `true` if `addr` is the all-zeros Stellar account key.
///
/// A zero address is the canonical burn address and is never a valid participant.
fn is_zero_address(env: &Env, addr: &Address) -> bool {
    // The all-zeros Stellar account key encodes to this strkey.
    let zero_address = Address::from_string(&String::from_str(
        env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    ));
    addr == &zero_address
}

/// The single-elimination bracket contract.
///
/// `#[contractimpl]` on the `impl` block below generates the exported
/// `TournamentBracket` entry points and the `TournamentBracketClient` used by
/// the unit tests.
#[contract]
pub struct TournamentBracket;

#[contractimpl]
impl TournamentBracket {
    // ------------------------------ views ------------------------------

    /// Total number of tournaments ever created.
    ///
    /// Exposed as a read-only view so frontends can paginate without enumerating.
    pub fn tournament_count(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TournamentCount)
            .unwrap_or(0)
    }

    /// The SEP-41 token address this contract was initialized with.
    pub fn get_token(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::Unauthorized)
    }

    /// Read a tournament by ID.
    pub fn get_tournament(env: &Env, tournament_id: u64) -> Result<Tournament, Error> {
        Self::load_tournament(env, tournament_id)
    }

    /// Read a single bracket node.
    ///
    /// # Errors
    ///
    /// [`Error::TournamentNotFound`] or [`Error::NodeNotFound`] if the tournament
    /// does not exist or has no node at `(round, index)`.
    pub fn get_node(
        env: &Env,
        tournament_id: u64,
        round: u32,
        index: u32,
    ) -> Result<MatchNode, Error> {
        Self::load_node(env, tournament_id, round, index)
    }

    /// The champion of a completed tournament.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidState`] if the tournament has no champion yet — either it
    /// has not been decided, or it was cancelled and refunded.
    pub fn get_champion(env: &Env, tournament_id: u64) -> Result<Address, Error> {
        let t = Self::load_tournament(env, tournament_id)?;
        t.champion.ok_or(Error::InvalidState)
    }

    /// The total prize pool on offer: `entry_fee × player_count`.
    ///
    /// This is the amount the champion receives. It is the same number whether
    /// the tournament is still in `Registration` or already `Completed`, so a UI
    /// can display it from the moment the bracket is created.
    pub fn get_prize_pool(env: &Env, tournament_id: u64) -> Result<i128, Error> {
        let t = Self::load_tournament(env, tournament_id)?;
        Ok(t.entry_fee * t.player_count as i128)
    }

    /// The immutable prize schedule recorded at creation time.
    pub fn get_prize_schedule(env: &Env, tournament_id: u64) -> Result<Vec<i128>, Error> {
        Ok(Self::load_tournament(env, tournament_id)?.prize_schedule)
    }

    /// How many entrants have paid their entry fee so far.
    pub fn get_funded_count(env: &Env, tournament_id: u64) -> Result<u32, Error> {
        let t = Self::load_tournament(env, tournament_id)?;
        Ok(t.funded_count)
    }

    // ---------------------------- lifecycle ----------------------------

    /// Initialize the contract.
    ///
    /// Can only be called once; subsequent calls return
    /// [`Error::AlreadyInitialized`].
    ///
    /// # Arguments
    ///
    /// * `admin` — The contract administrator. May cancel a tournament that is
    ///   still in `Registration`.
    /// * `oracle` — The address permitted to report match results and advance winners.
    /// * `token` — The SEP-41 token entry fees and prizes are denominated in.
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        token: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if is_zero_address(&env, &admin)
            || is_zero_address(&env, &oracle)
            || is_zero_address(&env, &token)
        {
            return Err(Error::InvalidAdmin);
        }

        // Prove `token` really is a SEP-41 contract before accepting entry fees
        // in it. Same validation the escrow contract performs.
        let token_client = token::Client::new(&env, &token);
        let _ = token_client.decimals();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::TournamentCount, &0u64);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "tournament"), symbol_short!("init")),
            (admin, oracle, token),
        );
        Ok(())
    }

    /// Create a single-elimination bracket.
    ///
    /// Builds the full node tree up front (`player_count - 1` nodes) and seeds
    /// round 0. Entrants are seeded in the order supplied: seed 1 plays seed N,
    /// seed 2 plays seed N−1, and so on, so the two strongest seeds can only meet
    /// in the final.
    ///
    /// # Arguments
    ///
    /// * `entry_fee` — What each entrant pays, in the smallest unit of the
    ///   configured token. Must be at least `MIN_ENTRY_FEE`, and
    ///   `entry_fee × players.len()` must not exceed `MAX_PRIZE_POOL`.
    /// * `players` — The entrants, strongest seed first. Must contain a power of
    ///   two number of distinct, non-zero addresses.
    ///
    /// # Returns
    ///
    /// The ID of the new tournament.
    ///
    /// # Errors
    ///
    /// * [`Error::InvalidPlayerCount`] — `players.len()` is not a power of two, or
    ///   is outside `[2, 64]`.
    /// * [`Error::DuplicatePlayer`] — an address appears twice.
    /// * [`Error::InvalidAddress`] — an entrant is the zero address.
    /// * [`Error::StakeTooLow`] / [`Error::StakeTooHigh`] — `entry_fee` out of range.
    pub fn create_tournament(
        env: Env,
        entry_fee: i128,
        players: Vec<Address>,
    ) -> Result<u64, Error> {
        // Default rules: winner takes the whole pool.
        let mut schedule: Vec<i128> = Vec::new(&env);
        let n = players.len() as i128;
        schedule.push_back(entry_fee.checked_mul(n).ok_or(Error::InvalidAmount)?);
        Self::create_tournament_with_prizes(env, entry_fee, players, schedule)
    }

    /// Like [`create_tournament`](Self::create_tournament) but records an explicit
    /// prize schedule (`prize_schedule[i]` is the prize for place `i + 1`) with the
    /// tournament. The schedule and token are immutable and readable through
    /// `get_prize_schedule` / `get_tournament`.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidPrizeSchedule`] if the schedule is empty, has a non-positive
    /// entry, has more places than entrants, or its total exceeds
    /// `entry_fee x players.len()`. Also all errors of `create_tournament`.
    pub fn create_tournament_with_prizes(
        env: Env,
        entry_fee: i128,
        players: Vec<Address>,
        prize_schedule: Vec<i128>,
    ) -> Result<u64, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::Unauthorized)?;

        if entry_fee < MIN_ENTRY_FEE {
            return Err(Error::StakeTooLow);
        }

        // A power of two keeps every round evenly filled, so nobody gets a bye.
        // The bounds are checked first so a field of 0 or 1 is rejected on its
        // own terms rather than as "not a power of two".
        let n = players.len();
        if n < MIN_PLAYERS || n > MAX_PLAYERS || !n.is_power_of_two() {
            return Err(Error::InvalidPlayerCount);
        }

        let prize_pool = entry_fee
            .checked_mul(n as i128)
            .ok_or(Error::InvalidAmount)?;
        if prize_pool > MAX_PRIZE_POOL {
            return Err(Error::StakeTooHigh);
        }

        if prize_schedule.is_empty() || prize_schedule.len() > n {
            return Err(Error::InvalidPrizeSchedule);
        }
        let mut total: i128 = 0;
        for p in prize_schedule.iter() {
            if p <= 0 {
                return Err(Error::InvalidPrizeSchedule);
            }
            total = total.checked_add(p).ok_or(Error::InvalidPrizeSchedule)?;
        }
        if total > prize_pool {
            return Err(Error::InvalidPrizeSchedule);
        }

        // Reject zero and duplicate entrants before anything is written.
        for i in 0..n {
            let a = players.get(i).ok_or(Error::InvalidPlayerCount)?;
            if is_zero_address(&env, &a) {
                return Err(Error::InvalidAddress);
            }
            let mut j = 0;
            while j < i {
                let b = players.get(j).ok_or(Error::InvalidPlayerCount)?;
                if a == b {
                    return Err(Error::DuplicatePlayer);
                }
                j += 1;
            }
        }

        let id = Self::tournament_count(&env);
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;
        let t = Tournament {
            id,
            admin,
            token: token_addr,
            entry_fee,
            player_count: n,
            // `n` is a power of two, so this is exactly log2(n).
            rounds: n.trailing_zeros(),
            funded_count: 0,
            state: TournamentState::Registration,
            champion: None,
            created_ledger: env.ledger().sequence(),
            completed_ledger: None,
            prize_schedule,
        };
        Self::save_tournament(&env, &t);

        // Publish the new ID before writing the nodes: `load_node` refuses to
        // read a tournament whose ID is not yet below the counter.
        env.storage()
            .instance()
            .set(&DataKey::TournamentCount, &next_id);

        // Build the whole tree now. Round `r` holds `n >> (r + 1)` nodes, so the
        // total is n/2 + n/4 + ... + 1 == n - 1.
        let mut r = 0u32;
        while r < t.rounds {
            let count = Self::node_count(n, r);
            let mut i = 0u32;
            while i < count {
                Self::save_node(
                    &env,
                    MatchNode {
                        tournament_id: id,
                        round: r,
                        index: i,
                        player1: None,
                        player2: None,
                        funded1: false,
                        funded2: false,
                        winner: None,
                        status: NodeStatus::AwaitingFunding,
                        result_ledger: None,
                    },
                );
                i += 1;
            }
            r += 1;
        }

        // Seed round 0: snake order, so seed 0 meets seed n-1, 1 meets n-2, ...
        let mut i = 0u32;
        while i < n / 2 {
            let p1 = players
                .get(Self::seed_position(2 * i, n))
                .ok_or(Error::InvalidPlayerCount)?;
            let p2 = players
                .get(Self::seed_position(2 * i + 1, n))
                .ok_or(Error::InvalidPlayerCount)?;
            let mut node = Self::load_node(&env, id, 0, i)?;
            node.player1 = Some(p1);
            node.player2 = Some(p2);
            Self::save_node(&env, node);
            i += 1;
        }

        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "tournament"), symbol_short!("created")),
            (id, n, entry_fee),
        );
        Ok(id)
    }

    /// Pay this entrant's entry fee.
    ///
    /// Called once per entrant, by the entrant. Both players of a first-round node
    /// move to `AwaitingResult` as soon as they have both paid, and the tournament
    /// moves to [`TournamentState::InProgress`] once every entrant has paid.
    ///
    /// # Errors
    ///
    /// * [`Error::PlayerNotRegistered`] — the caller is not an entrant.
    /// * [`Error::AlreadyFunded`] — this entrant has already paid.
    /// * [`Error::TournamentFinished`] — the tournament is completed or cancelled.
    pub fn deposit(env: Env, tournament_id: u64, player: Address) -> Result<(), Error> {
        player.require_auth();

        let mut t = Self::load_tournament(&env, tournament_id)?;
        if t.state == TournamentState::Completed || t.state == TournamentState::Cancelled {
            return Err(Error::TournamentFinished);
        }

        let (node_index, is_first) =
            Self::find_entry_slot(&env, &t, &player)?.ok_or(Error::PlayerNotRegistered)?;

        let mut node = Self::load_node(&env, tournament_id, 0, node_index)?;
        if (is_first && node.funded1) || (!is_first && node.funded2) {
            return Err(Error::AlreadyFunded);
        }

        let client = token::Client::new(&env, &t.token);
        client.transfer(&player, &env.current_contract_address(), &t.entry_fee);

        if is_first {
            node.funded1 = true;
        } else {
            node.funded2 = true;
        }
        if node.funded1 && node.funded2 {
            node.status = NodeStatus::AwaitingResult;
        }
        Self::save_node(&env, node);

        t.funded_count += 1;
        if t.funded_count == t.player_count {
            t.state = TournamentState::InProgress;
        }
        Self::save_tournament(&env, &t);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "tournament"), symbol_short!("deposit")),
            (tournament_id, player, t.entry_fee),
        );
        Ok(())
    }

    /// Report the result of one match and advance its winner.
    ///
    /// Callable only by the registered oracle. The winner is named by `Address`
    /// and must be one of the node's two entrants — a draw is not representable
    /// in a single-elimination bracket, and naming an address that is not in the
    /// match is rejected rather than silently accepted.
    ///
    /// If the node is not the final, its winner is written into the parent node
    /// and the parent becomes `AwaitingResult` once both its slots are filled. If
    /// it *is* the final, the tournament completes and the champion is paid the
    /// whole prize pool in this same call.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — caller is not the oracle.
    /// * [`Error::InvalidGameId`] — `game_id` is empty, too long, or has
    ///   characters outside `[A-Za-z0-9_-]`.
    /// * [`Error::InvalidNodeStatus`] — the node is not `AwaitingResult`.
    /// * [`Error::WinnerNotInMatch`] — `winner` is not one of the node's entrants.
    /// * [`Error::TransferFailed`] — the champion transfer failed; the match result and payout are rolled back.
    /// * [`Error::TournamentFinished`] — the tournament is completed or cancelled.
    pub fn submit_match_result(
        env: Env,
        tournament_id: u64,
        round: u32,
        index: u32,
        game_id: String,
        winner: Address,
    ) -> Result<(), Error> {
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::Oracle)
            .ok_or(Error::Unauthorized)?;
        oracle.require_auth();

        let mut t = Self::load_tournament(&env, tournament_id)?;
        if t.state == TournamentState::Completed || t.state == TournamentState::Cancelled {
            return Err(Error::TournamentFinished);
        }

        let len = game_id.len();
        if len == 0 || len > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }
        if !Self::is_valid_game_id(&game_id) {
            return Err(Error::InvalidGameId);
        }

        let mut node = Self::load_node(&env, tournament_id, round, index)?;
        if node.status != NodeStatus::AwaitingResult {
            return Err(Error::InvalidNodeStatus);
        }
        if node.player1.as_ref() != Some(&winner) && node.player2.as_ref() != Some(&winner) {
            return Err(Error::WinnerNotInMatch);
        }

        node.winner = Some(winner.clone());
        node.status = NodeStatus::Decided;
        node.result_ledger = Some(env.ledger().sequence());
        Self::save_node(&env, node);

        if round + 1 < t.rounds {
            // Not the final: advance into the parent node. Node `i` of round `r`
            // feeds node `i / 2` of round `r + 1`.
            let parent_index = index / 2;
            let mut parent = Self::load_node(&env, tournament_id, round + 1, parent_index)?;
            if index % 2 == 0 {
                parent.player1 = Some(winner.clone());
            } else {
                parent.player2 = Some(winner.clone());
            }
            if parent.player1.is_some() && parent.player2.is_some() {
                parent.status = NodeStatus::AwaitingResult;
            }
            Self::save_node(&env, parent);

            Self::bump_instance_ttl(&env);
            env.events().publish(
                (Symbol::new(&env, "tournament"), symbol_short!("advanced")),
                (tournament_id, round, index, winner),
            );
            return Ok(());
        }

        // The final: crown the champion and pay the whole pot. No payout happens
        // before this point — an earlier-round winner keeps their fee in the pot.
        t.champion = Some(winner.clone());
        t.state = TournamentState::Completed;
        t.completed_ledger = Some(env.ledger().sequence());
        let payout = t.entry_fee * t.player_count as i128;
        Self::ensure_reserve_for_payout(&env, &t.token, payout)?;
        let client = token::Client::new(&env, &t.token);
        client
            .try_transfer(&env.current_contract_address(), &winner, &payout)
            .map_err(|_| Error::TransferFailed)?
            .map_err(|_| Error::TransferFailed)?;

        // Persist the terminal state only after the token transfer succeeds. Any
        // later storage failure still aborts the Soroban invocation and rolls the
        // transfer back with the rest of the transaction.
        Self::save_tournament(&env, &t);

        Self::bump_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "tournament"), symbol_short!("champion")),
            (tournament_id, winner, payout),
        );
        Ok(())
    }

    /// Abandon a tournament that has not started and refund every funded entrant.
    ///
    /// Admin only, and only while the tournament is still in
    /// [`Registration`](TournamentState::Registration) — i.e. no match has been
    /// decided. Once results are in, the pot is committed and only the
    /// trustless `claim_timeout` path remains.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — caller is not the admin.
    /// * [`Error::TournamentInProgress`] — at least one match has been decided.
    /// * [`Error::TransferFailed`] — a refund transfer failed; the cancellation and all earlier refunds are rolled back.
    pub fn cancel_tournament(env: Env, tournament_id: u64) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        let mut t = Self::load_tournament(&env, tournament_id)?;
        if t.state != TournamentState::Registration {
            return Err(Error::TournamentInProgress);
        }

        // Recorded before the refund, which zeroes the counter.
        let refunded = t.funded_count;
        Self::refund_all(&env, &mut t)?;
        t.state = TournamentState::Cancelled;
        t.completed_ledger = Some(env.ledger().sequence());
        Self::save_tournament(&env, &t);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "tournament"), symbol_short!("cancelled")),
            (tournament_id, refunded),
        );
        Ok(())
    }

    /// Refund everyone once the tournament has clearly stalled.
    ///
    /// Callable by **anyone** once `TIMEOUT_LEDGERS` have elapsed since the
    /// tournament was created, so a stalled bracket can never hold player funds
    /// indefinitely. This is the trustless backstop; it mirrors
    /// `EscrowContract::claim_timeout`, which is likewise permissionless.
    ///
    /// Note this resolves a stalled tournament by refunding *everyone* rather than
    /// picking a default winner. Deciding who advances when a player refuses to
    /// play is real policy and is out of scope — see ADR-003, "Known limitation".
    ///
    /// # Errors
    ///
    /// * [`Error::TimeoutNotReached`] — the window has not elapsed yet.
    /// * [`Error::TransferFailed`] — a refund transfer failed; cancellation and all earlier refunds are rolled back.
    /// * [`Error::TournamentFinished`] — already completed or cancelled.
    pub fn claim_timeout(env: Env, tournament_id: u64, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut t = Self::load_tournament(&env, tournament_id)?;
        if t.state == TournamentState::Completed || t.state == TournamentState::Cancelled {
            return Err(Error::TournamentFinished);
        }
        if env.ledger().sequence() <= t.created_ledger + TIMEOUT_LEDGERS {
            return Err(Error::TimeoutNotReached);
        }

        // Recorded before the refund, which zeroes the counter.
        let refunded = t.funded_count;
        Self::refund_all(&env, &mut t)?;
        t.state = TournamentState::Cancelled;
        t.completed_ledger = Some(env.ledger().sequence());
        Self::save_tournament(&env, &t);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "tournament"), symbol_short!("timeout")),
            (tournament_id, refunded, caller),
        );
        Ok(())
    }

    // ---------------------------- internals ----------------------------

    /// Extend the lifetime of the contract's instance-storage entries.
    ///
    /// Instance storage (admin, oracle, token, tournament count) shares a single
    /// TTL, so it is bumped as a unit after every mutating call.
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Number of nodes in round `r` of a `player_count`-entrant bracket.
    fn node_count(player_count: u32, round: u32) -> u32 {
        player_count >> (round + 1)
    }

    /// Map a round-0 seed slot to a position in the entrants list.
    ///
    /// Snake seeding: slot 0 is the top seed, slot 1 the bottom seed, slot 2 the
    /// second seed, and so on. For 4 entrants that gives
    /// `0 -> 0, 1 -> 3, 2 -> 1, 3 -> 2`, i.e. `[s0 s3] [s1 s2]`.
    fn seed_position(index: u32, player_count: u32) -> u32 {
        if index % 2 == 0 {
            index / 2
        } else {
            player_count - 1 - index / 2
        }
    }

    /// Find `player` in round 0. Returns `Some((node_index, is_first_slot))`.
    fn find_entry_slot(
        env: &Env,
        t: &Tournament,
        player: &Address,
    ) -> Result<Option<(u32, bool)>, Error> {
        let mut i = 0u32;
        while i < t.player_count / 2 {
            let node = Self::load_node(env, t.id, 0, i)?;
            if node.player1.as_ref() == Some(player) {
                return Ok(Some((i, true)));
            }
            if node.player2.as_ref() == Some(player) {
                return Ok(Some((i, false)));
            }
            i += 1;
        }
        Ok(None)
    }

    /// Validate that every byte of `game_id` belongs to `[A-Za-z0-9_-]`.
    ///
    /// Mirrors the escrow contract's check: printable ASCII only, so null bytes,
    /// control characters, whitespace and non-ASCII sequences never enter
    /// persistent storage where they would diverge from the platform's own
    /// game-ID format.
    ///
    /// The string is copied into a fixed stack buffer of `MAX_GAME_ID_LEN` bytes,
    /// so no heap allocation is required inside the WASM guest.
    fn is_valid_game_id(game_id: &String) -> bool {
        let len = game_id.len() as usize;
        // Safety: len is already validated to be in [1, MAX_GAME_ID_LEN].
        let mut buf = [0u8; MAX_GAME_ID_LEN as usize];
        game_id.copy_into_slice(&mut buf[..len]);
        for i in 0..len {
            let b = buf[i];
            let ok = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
            if !ok {
                return false;
            }
        }
        true
    }

    /// Reject a payout that would drop the contract below
    /// [`ESCROW_RESERVE_BUFFER_STROOPS`].
    ///
    /// Without this a `transfer` could fail at the Stellar protocol layer with a
    /// reserve-induced `op_under_min_balance`, leaving the tournament marked
    /// `Completed` with the champion unpaid. Same guard as the escrow contract.
    fn ensure_reserve_for_payout(
        env: &Env,
        token: &Address,
        payout_total: i128,
    ) -> Result<(), Error> {
        let client = token::Client::new(env, token);
        let balance = client.balance(&env.current_contract_address());
        if balance < payout_total + ESCROW_RESERVE_BUFFER_STROOPS {
            return Err(Error::InsufficientReserve);
        }
        Ok(())
    }

    /// Refund every entrant who has paid, and clear their funded flags.
    fn refund_all(env: &Env, t: &mut Tournament) -> Result<(), Error> {
        if t.funded_count == 0 {
            return Ok(());
        }
        Self::ensure_reserve_for_payout(env, &t.token, t.entry_fee * t.funded_count as i128)?;

        let contract = env.current_contract_address();
        let client = token::Client::new(env, &t.token);
        let mut i = 0u32;
        while i < t.player_count / 2 {
            let mut node = Self::load_node(env, t.id, 0, i)?;
            if node.funded1 {
                if let Some(p) = node.player1.clone() {
                    client
                        .try_transfer(&contract, &p, &t.entry_fee)
                        .map_err(|_| Error::TransferFailed)?
                        .map_err(|_| Error::TransferFailed)?;
                }
                node.funded1 = false;
            }
            if node.funded2 {
                if let Some(p) = node.player2.clone() {
                    client
                        .try_transfer(&contract, &p, &t.entry_fee)
                        .map_err(|_| Error::TransferFailed)?
                        .map_err(|_| Error::TransferFailed)?;
                }
                node.funded2 = false;
            }
            Self::save_node(env, node);
            i += 1;
        }
        t.funded_count = 0;
        Ok(())
    }

    fn load_tournament(env: &Env, tournament_id: u64) -> Result<Tournament, Error> {
        if tournament_id >= Self::tournament_count(env) {
            return Err(Error::TournamentNotFound);
        }
        env.storage()
            .persistent()
            .get::<DataKey, Tournament>(&DataKey::Tournament(tournament_id))
            .ok_or(Error::TournamentNotFound)
    }

    fn load_node(
        env: &Env,
        tournament_id: u64,
        round: u32,
        index: u32,
    ) -> Result<MatchNode, Error> {
        let t = Self::load_tournament(env, tournament_id)?;
        if round >= t.rounds || index >= Self::node_count(t.player_count, round) {
            return Err(Error::NodeNotFound);
        }
        env.storage()
            .persistent()
            .get::<DataKey, MatchNode>(&DataKey::Node(tournament_id, round, index))
            .ok_or(Error::NodeNotFound)
    }

    fn save_tournament(env: &Env, t: &Tournament) {
        let key = DataKey::Tournament(t.id);
        env.storage().persistent().set(&key, t);
        env.storage()
            .persistent()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
    }

    fn save_node(env: &Env, node: MatchNode) {
        let key = DataKey::Node(node.tournament_id, node.round, node.index);
        env.storage().persistent().set(&key, &node);
        env.storage()
            .persistent()
            .extend_ttl(&key, MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
    }
}

#[cfg(test)]
mod tests;
