//! # Oracle Contract
//!
//! This module implements the on-chain oracle contract for the Smile4Money chess-escrow
//! system on Stellar Soroban.
//!
//! ## Role in the System
//!
//! The oracle contract acts as the trusted bridge between off-chain chess game results
//! and the on-chain escrow contract. The off-chain oracle service (a backend process that
//! monitors Lichess and Chess.com APIs) calls [`submit_result`] to record a verified game
//! outcome on-chain. The escrow contract then reads this result (or is called directly via
//! `submit_result` on the escrow side) to determine payout.
//!
//! ## Relationship to the Escrow Contract
//!
//! ```text
//! Off-chain Service
//!        │
//!        │  submit_result(match_id, game_id, result)
//!        ▼
//! ┌─────────────────┐       get_result(match_id)      ┌──────────────────┐
//! │  Oracle Contract│ ──────────────────────────────► │  Escrow Contract │
//! └─────────────────┘                                  └──────────────────┘
//! ```
//!
//! The oracle contract stores results immutably (one result per match). The escrow contract
//! validates the caller is the registered oracle address before processing any payout.
//!
//! ## Result Submission Flow
//!
//! 1. A chess game completes on Lichess or Chess.com.
//! 2. The off-chain oracle service fetches the result from the platform API.
//! 3. The oracle service calls [`submit_result`] with the `match_id`, `game_id`, and
//!    the outcome (`Player1Wins`, `Player2Wins`, or `Draw`).
//! 4. The contract validates the admin signature, checks for duplicates, and stores the
//!    [`ResultEntry`] in persistent storage.
//! 5. After the dispute window (defined in the escrow contract) expires, the escrow
//!    contract processes the payout based on this stored result.
//!
//! ## Dispute Window
//!
//! Results submitted to the **escrow** contract enter a `PendingResult` state for
//! `DISPUTE_WINDOW_LEDGERS` (~24 hours) before payout is executed. During this window
//! the admin can call `override_result` on the escrow contract to correct an erroneous
//! submission. See [`contracts/escrow/src/lib.rs`] for details.
//!
//! ## Further Reading
//!
//! - Full API reference with examples: [`docs/api-reference.md`](../../docs/api-reference.md)
//! - Oracle architecture and sequence diagrams: [`docs/oracle.md`](../../docs/oracle.md)

#![no_std]

mod constants;
mod errors;
mod types;

pub use constants::*;

use errors::Error;
use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, String, Symbol, Vec};
use types::{DataKey, InstanceState, MatchResult, ResultEntry};

/// Validate that every byte of `game_id` belongs to the set `[A-Za-z0-9_-]`.
///
/// This enforces printable ASCII and prevents null bytes, control characters,
/// whitespace, and non-ASCII sequences from entering persistent storage.
/// The allowed set mirrors both the identifier format used by Lichess and
/// Chess.com and the identical check performed by the escrow contract, ensuring
/// the two contracts always agree on what constitutes a valid `game_id`.
///
/// The string is copied into a fixed 64-byte stack buffer — the same size as
/// `MAX_GAME_ID_LEN` — so no heap allocation is required inside the WASM guest.
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

fn bump_initialized_ttl(env: &Env) {
    env.storage().persistent().extend_ttl(
        &DataKey::IsInitialized,
        MATCH_TTL_LEDGERS,
        MATCH_TTL_LEDGERS,
    );
}

#[contract]
pub struct OracleContract;

#[contractimpl]
impl OracleContract {
    /// Read the current admin for deployment authorization checks.
    /// Does not mutate state or grant authority.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        let state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        Ok(state.admin)
    }

    /// Initialize the oracle contract with a trusted admin address.
    ///
    /// The `admin` is the address of the off-chain oracle service that is authorised
    /// to submit game results. This function can only be called once — subsequent calls
    /// return [`Error::AlreadyInitialized`].
    ///
    /// # Arguments
    ///
    /// * `admin` — The Stellar address of the trusted off-chain oracle service.
    ///
    /// # Errors
    ///
    /// Returns [`Error::AlreadyInitialized`] if the contract has already been set up.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::IsInitialized) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::IsInitialized, &true);
        bump_initialized_ttl(&env);
        env.storage().instance().set(
            &DataKey::InstanceState,
            &InstanceState {
                admin: admin.clone(),
                result_count: 0,
            },
        );
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        env.events()
            .publish((Symbol::new(&env, "oracle"), symbol_short!("init")), admin);
        Ok(())
    }

    /// Submit a verified chess game result on-chain.
    ///
    /// Called by the off-chain oracle service (`admin`) once the game outcome has been
    /// confirmed via the chess platform API. The result is stored immutably in persistent
    /// storage; any attempt to submit a second result for the same `match_id` is rejected.
    ///
    /// On the escrow contract side, this triggers the `PendingResult` dispute window before
    /// payout is executed.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID this result belongs to.
    /// * `game_id`  — The platform-specific game identifier (e.g. Lichess game ID). Must be
    ///   non-empty, at most 64 bytes, and contain only `[A-Za-z0-9_-]` characters.
    /// * `result`   — The outcome: [`MatchResult::Player1Wins`], [`MatchResult::Player2Wins`],
    ///   or [`MatchResult::Draw`].
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]     — Caller is not the registered admin.
    /// * [`Error::InvalidGameId`]    — `game_id` is empty, exceeds 64 bytes, or contains
    ///   characters outside `[A-Za-z0-9_-]` (null bytes, control characters, whitespace,
    ///   non-ASCII sequences, etc.).
    /// * [`Error::AlreadySubmitted`] — A result already exists for this `match_id`.
    pub fn submit_result(
        env: Env,
        match_id: u64,
        game_id: String,
        result: MatchResult,
    ) -> Result<(), Error> {
        // Keep admin and result_count in one instance entry so this hot path loads both
        // values with one storage read instead of reading each key independently.
        let mut instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin.clone();
        admin.require_auth();

        let game_id_len = game_id.len();
        if game_id_len == 0 || game_id_len > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }

        // Enforce printable ASCII: only [A-Za-z0-9_-] are accepted.
        // This mirrors the identical check in the escrow contract and closes the
        // gap where a caller could submit a game_id containing null bytes, control
        // characters, or non-ASCII sequences that would pass the length check but
        // permanently diverge from the escrow's stored game_id, causing an
        // irrecoverable GameIdMismatch that locks player funds.
        if !is_valid_game_id(&game_id) {
            return Err(Error::InvalidGameId);
        }

        if env.storage().persistent().has(&DataKey::Result(match_id)) {
            return Err(Error::AlreadySubmitted);
        }

        let ledger_seq = env.ledger().sequence();
        // SAFETY: Soroban's single-execution model prevents re-entrancy; no cross-contract
        // calls are made here, so the state written below cannot be observed by a
        // re-entrant caller before this function returns.
        env.storage().persistent().set(
            &DataKey::Result(match_id),
            &ResultEntry {
                game_id: game_id.clone(),
                result: result.clone(),
                submitted_ledger: ledger_seq,
            },
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Result(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        bump_initialized_ttl(&env);

        // Increment the result count so callers can construct efficient page ranges
        // without scanning sparse ID spaces.
        instance_state.result_count += 1;
        env.storage()
            .instance()
            .set(&DataKey::InstanceState, &instance_state);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("result")),
            (match_id, game_id, result),
        );

        Ok(())
    }

    /// Retrieve the stored result for a match.
    ///
    /// Returns the full [`ResultEntry`] (game_id + result) for the given `match_id`.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID to look up.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ResultNotFound`] if no result has been submitted yet.
    pub fn get_result(env: Env, match_id: u64) -> Result<ResultEntry, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Result(match_id))
            .ok_or(Error::ResultNotFound)
    }

    /// Check whether a result has been submitted for a match.
    ///
    /// Returns `true` if [`submit_result`] has been called for the given `match_id`,
    /// `false` otherwise. Safe to call by anyone — no auth required.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID to check.
    pub fn has_result(env: Env, match_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::Result(match_id))
    }

    /// Step 1 of two-step admin transfer: propose a new admin address.
    ///
    /// Records `new_admin` as the pending admin. The transfer is not effective until
    /// the proposed address calls [`accept_admin`]. Only the current admin may call
    /// this function. Replaces any previously outstanding proposal.
    ///
    /// # Arguments
    ///
    /// * `new_admin` — The Stellar address being nominated as the next admin.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]  — Contract not initialized or caller is not the admin.
    /// * [`Error::InvalidAdmin`]  — `new_admin` is the zero/burn address or is the same
    ///   as the current admin.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin.clone();
        admin.require_auth();

        // Reject the zero/burn address — it can never sign a transaction.
        let zero_addr = Address::from_strkey(
            &env,
            &soroban_sdk::String::from_str(
                &env,
                "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
            ),
        );
        if new_admin == zero_addr {
            return Err(Error::InvalidAdmin);
        }

        // Proposing the current admin as the next admin makes no sense.
        if new_admin == admin {
            return Err(Error::InvalidAdmin);
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_prop")),
            (admin, new_admin),
        );

        Ok(())
    }

    /// Step 2 of two-step admin transfer: the proposed admin accepts the role.
    ///
    /// Completes the transfer by writing the pending admin as the active admin and
    /// clearing the pending proposal. Only the address that was proposed via
    /// [`propose_admin`] may call this function.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]    — Contract not initialized or caller is not the
    ///   pending admin.
    /// * [`Error::NoPendingAdmin`]  — No proposal is outstanding.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let mut instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;

        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NoPendingAdmin)?;

        pending.require_auth();

        let old_admin = instance_state.admin.clone();
        instance_state.admin = pending.clone();
        env.storage()
            .instance()
            .set(&DataKey::InstanceState, &instance_state);
        env.storage()
            .instance()
            .remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_xfer")),
            (old_admin, pending),
        );

        Ok(())
    }

    /// Cancel an outstanding admin transfer proposal.
    ///
    /// Removes the pending admin address without changing the active admin. Only the
    /// current admin may call this function.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]   — Contract not initialized or caller is not the admin.
    /// * [`Error::NoPendingAdmin`] — No proposal is outstanding.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin;
        admin.require_auth();

        if !env
            .storage()
            .instance()
            .has(&DataKey::PendingAdmin)
        {
            return Err(Error::NoPendingAdmin);
        }

        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap();

        env.storage()
            .instance()
            .remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_cncl")),
            (admin, pending),
        );

        Ok(())
    }

    /// Recover tokens accidentally sent to the oracle contract address.
    ///
    /// Only the admin may call this. Uses `try_transfer` so that a failed transfer
    /// returns [`Error::TransferFailed`] rather than aborting the transaction.
    ///
    /// # Arguments
    ///
    /// * `token`  — The SEP-41 token contract address.
    /// * `amount` — Number of stroops to transfer (must be > 0).
    /// * `to`     — Destination address for the recovered funds.
    /// * `caller` — Must equal the registered admin; `require_auth` is called on it.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]   — Contract not yet initialized or caller ≠ admin.
    /// * [`Error::InvalidAmount`]   — `amount` is zero or negative.
    /// * [`Error::TransferFailed`] — The token transfer was rejected.
    pub fn withdraw(
        env: Env,
        token: Address,
        amount: i128,
        to: Address,
        caller: Address,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get::<DataKey, InstanceState>(&DataKey::InstanceState)
            .map(|state| state.admin)
            .ok_or(Error::Unauthorized)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // SAFETY: token::Client::try_transfer is a cross-contract call. Soroban's
        // single-execution model ensures no re-entrancy is possible: the token
        // contract cannot call back into this oracle contract during the transfer.
        token::Client::new(&env, &token)
            .try_transfer(&env.current_contract_address(), &to, &amount)
            .map_err(|_| Error::TransferFailed)?;

        // Emit an on-chain audit event for recovered funds so there is a
        // blockchain-level record of what token, amount, destination and admin
        // performed the recovery.
        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("withdraw")),
            (token, amount, to, admin),
        );

        Ok(())
    }

    /// Return the total number of results that have been submitted so far.
    ///
    /// Clients can use this to build efficient page requests for [`list_results`]:
    /// iterate in windows of up to [`MAX_LIST_LIMIT`] starting from 0 up to
    /// `get_result_count()` to avoid scanning gaps in sparse ID spaces.
    ///
    /// [`list_results`]: OracleContract::list_results
    pub fn get_result_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get::<DataKey, InstanceState>(&DataKey::InstanceState)
            .map(|state| state.result_count)
            .unwrap_or(0)
    }

    /// Enumerate stored results for off-chain reconciliation.
    ///
    /// Returns up to `limit` `(match_id, ResultEntry)` pairs starting from `start`,
    /// scanning match IDs up to `min(start + limit, get_result_count())`. IDs with no
    /// stored result are skipped. `limit` is capped at [`MAX_LIST_LIMIT`] (100) to
    /// bound compute.
    ///
    /// Use [`get_result_count`] to determine the upper bound of submitted results and
    /// construct tight page requests — this avoids wasting compute budget on storage
    /// misses when the ID space is sparse.
    ///
    /// [`get_result_count`]: OracleContract::get_result_count
    ///
    /// # Arguments
    ///
    /// * `start` — First match_id to check (inclusive).
    /// * `limit` — Maximum number of entries to return (capped at 100).
    pub fn list_results(env: Env, start: u64, limit: u32) -> Vec<(u64, ResultEntry)> {
        let cap = limit.min(MAX_LIST_LIMIT);
        let result_count: u64 = env
            .storage()
            .instance()
            .get::<DataKey, InstanceState>(&DataKey::InstanceState)
            .map(|state| state.result_count)
            .unwrap_or(0u64);
        let end = start.saturating_add(cap as u64).min(result_count);
        let mut out: Vec<(u64, ResultEntry)> = Vec::new(&env);
        for id in start..end {
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<DataKey, ResultEntry>(&DataKey::Result(id))
            {
                out.push_back((id, entry));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Events},
        vec, Address, Env, IntoVal, String, Symbol,
    };

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, contract_id)
    }

    #[test]
    fn test_submit_and_get_result() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert!(!client.has_result(&0u64));

        client.submit_result(
            &0u64,
            &String::from_str(&env, "abc-123_XYZ"),
            &MatchResult::Player1Wins,
        );

        assert!(client.has_result(&0u64));
        assert_eq!(client.get_result(&0u64).result, MatchResult::Player1Wins);

        // TTL must be extended
        let ttl = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&DataKey::Result(0u64))
        });
        assert_eq!(ttl, crate::MATCH_TTL_LEDGERS);
    }

    #[test]
    fn test_get_result_not_found() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        assert!(matches!(
            client.try_get_result(&999u64),
            Err(Ok(Error::ResultNotFound))
        ));
    }

    #[test]
    fn test_submit_result_empty_game_id_fails() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_submit_result(
                &0u64,
                &String::from_str(&env, ""),
                &MatchResult::Player1Wins,
            ),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_submit_result_invalid_game_id_characters_fail() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_submit_result(
                &0u64,
                &String::from_str(&env, "game.id"),
                &MatchResult::Player1Wins,
            ),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_submit_result_game_id_over_max_byte_length_fails() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let game_id = String::from_bytes(&env, &[b'a'; MAX_GAME_ID_LEN as usize + 1]);

        assert_eq!(
            client.try_submit_result(&0u64, &game_id, &MatchResult::Player1Wins),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_submit_result_by_non_admin_returns_unauthorized() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "submit_result",
                args: (
                    1u64,
                    String::from_str(&env, "game1"),
                    MatchResult::Player1Wins,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(
            client
                .try_submit_result(
                    &1u64,
                    &String::from_str(&env, "game1"),
                    &MatchResult::Player1Wins
                )
                .is_err(),
            "non-admin must not be able to submit results"
        );
        assert!(
            !client.has_result(&1u64),
            "result must not be stored after rejected submission"
        );
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let replacement_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let initial_admin = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get::<DataKey, InstanceState>(&DataKey::InstanceState)
                .unwrap()
                .admin
        });
        assert_eq!(initial_admin, admin);
        assert!(env.as_contract(&contract_id, || env
            .storage()
            .persistent()
            .has(&DataKey::IsInitialized)));

        assert_eq!(
            client.try_initialize(&replacement_admin),
            Err(Ok(Error::AlreadyInitialized))
        );

        let admin_after_retry = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get::<DataKey, InstanceState>(&DataKey::InstanceState)
                .unwrap()
                .admin
        });
        assert_eq!(admin_after_retry, admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_duplicate_submit_fails() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        client.submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw);
        client.submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw);
    }

    #[test]
    fn test_has_result_false_for_non_existent() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        assert!(!client.has_result(&999u64));
    }

    #[test]
    fn test_propose_and_accept_admin_happy_path() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);

        // Step 1: current admin proposes
        client.propose_admin(&new_admin);

        // Step 2: proposed admin accepts
        client.accept_admin();

        // The new admin can now submit results
        client.submit_result(
            &1u64,
            &String::from_str(&env, "game1"),
            &MatchResult::Player2Wins,
        );
        assert_eq!(client.get_result(&1u64).result, MatchResult::Player2Wins);
    }

    #[test]
    fn test_propose_admin_emits_proposal_event() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);

        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("adm_prop").into_val(&env),
        ];
        assert!(events.iter().any(|(_, t, _)| t == topics), "adm_prop event must be emitted");
    }

    #[test]
    fn test_accept_admin_emits_transfer_event() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.accept_admin();

        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("adm_xfer").into_val(&env),
        ];
        assert!(events.iter().any(|(_, t, _)| t == topics), "adm_xfer event must be emitted on accept");
    }

    #[test]
    fn test_accept_admin_extends_instance_ttl() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);

        let ttl_before = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        client.accept_admin();
        let ttl_after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());

        assert!(
            ttl_after >= crate::MATCH_TTL_LEDGERS,
            "Instance TTL must be extended after accept_admin: before={ttl_before}, after={ttl_after}"
        );
    }

    #[test]
    fn test_non_admin_cannot_propose_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(
            client.try_propose_admin(&new_admin).is_err(),
            "non-admin must not be able to propose a new admin"
        );
    }

    #[test]
    fn test_non_pending_cannot_accept_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let proposed = Address::generate(&env);
        let impostor = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        // Propose `proposed`, but have `impostor` try to accept
        env.mock_all_auths_allowing_non_root_auth();
        client.propose_admin(&proposed);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);

        // Should fail because require_auth() on `proposed` won't be satisfied by `impostor`
        assert!(
            client.try_accept_admin().is_err(),
            "only the pending admin must be able to accept"
        );
    }

    #[test]
    fn test_accept_admin_without_proposal_returns_no_pending_admin() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(Error::NoPendingAdmin)),
            "accept_admin with no outstanding proposal must return NoPendingAdmin"
        );
    }

    #[test]
    fn test_cancel_admin_transfer_clears_proposal() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);

        client.propose_admin(&new_admin);
        client.cancel_admin_transfer();

        // accept should now fail with NoPendingAdmin
        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(Error::NoPendingAdmin)),
            "after cancellation there must be no pending proposal"
        );
    }

    #[test]
    fn test_cancel_admin_transfer_emits_event() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);
        client.propose_admin(&new_admin);
        client.cancel_admin_transfer();

        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("adm_cncl").into_val(&env),
        ];
        assert!(events.iter().any(|(_, t, _)| t == topics), "adm_cncl event must be emitted");
    }

    #[test]
    fn test_cancel_admin_transfer_without_proposal_returns_no_pending_admin() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert_eq!(
            client.try_cancel_admin_transfer(),
            Err(Ok(Error::NoPendingAdmin)),
            "cancel with no outstanding proposal must return NoPendingAdmin"
        );
    }

    #[test]
    fn test_non_admin_cannot_cancel_admin_transfer() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let proposed = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        env.mock_all_auths_allowing_non_root_auth();
        client.propose_admin(&proposed);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel_admin_transfer",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(
            client.try_cancel_admin_transfer().is_err(),
            "non-admin must not be able to cancel a pending proposal"
        );
    }

    #[test]
    fn test_propose_admin_zero_address_returns_invalid_admin() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        let zero_addr = Address::from_strkey(
            &env,
            &String::from_str(
                &env,
                "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
            ),
        );

        assert_eq!(
            client.try_propose_admin(&zero_addr),
            Err(Ok(Error::InvalidAdmin)),
            "propose_admin must reject the zero address with InvalidAdmin"
        );
    }

    #[test]
    fn test_propose_admin_self_returns_invalid_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        assert_eq!(
            client.try_propose_admin(&admin),
            Err(Ok(Error::InvalidAdmin)),
            "proposing the current admin must return InvalidAdmin"
        );
    }

    #[test]
    fn test_pending_admin_cleared_after_accept() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let new_admin = Address::generate(&env);

        client.propose_admin(&new_admin);
        client.accept_admin();

        // A second accept must now fail — the pending key was cleared
        assert_eq!(
            client.try_accept_admin(),
            Err(Ok(Error::NoPendingAdmin)),
            "pending admin must be cleared after successful accept"
        );
    }

    #[test]
    fn test_propose_admin_replaces_previous_proposal() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let first_candidate = Address::generate(&env);
        let second_candidate = Address::generate(&env);

        client.propose_admin(&first_candidate);
        // Replace the proposal with a different address
        client.propose_admin(&second_candidate);

        // first_candidate can no longer accept
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &first_candidate,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            client.try_accept_admin().is_err(),
            "first candidate must not be able to accept after proposal was replaced"
        );
    }

    #[test]
    fn test_withdraw_zero_amount_returns_invalid_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let token = Address::generate(&env);
        let recipient = Address::generate(&env);

        assert_eq!(
            client.try_withdraw(&token, &0i128, &recipient, &admin),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_withdraw(&token, &(-1i128), &recipient, &admin),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn test_initialize_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let events = env.events().all();
        let topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("init").into_val(&env),
        ];
        let matched = events.iter().find(|(_, t, _)| *t == topics);
        assert!(matched.is_some());
    }

    #[test]
    fn test_initialize_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        // Verify that the instance storage TTL was extended
        let instance_ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
        assert!(
            instance_ttl >= crate::MATCH_TTL_LEDGERS,
            "Instance TTL must be at least MATCH_TTL_LEDGERS"
        );
    }

    #[test]
    fn test_oracle_submit_result_emits_event_player1_wins() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.submit_result(
            &1u64,
            &String::from_str(&env, "game_abc"),
            &MatchResult::Player1Wins,
        );

        let expected_topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("result").into_val(&env),
        ];

        let events = env.events().all();
        let matched = events
            .iter()
            .find(|(_, topics, _)| *topics == expected_topics);

        assert!(matched.is_some(), "No result event emitted for Player1Wins");

        let (_, _, actual_data) = matched.unwrap();
        let (ev_match_id, ev_game_id, ev_result): (u64, String, MatchResult) =
            soroban_sdk::TryFromVal::try_from_val(&env, &actual_data).unwrap();
        assert_eq!(ev_match_id, 1u64, "match_id mismatch for Player1Wins");
        assert_eq!(
            ev_game_id,
            String::from_str(&env, "game_abc"),
            "game_id mismatch for Player1Wins"
        );
        assert_eq!(
            ev_result,
            MatchResult::Player1Wins,
            "result mismatch for Player1Wins"
        );
    }

    #[test]
    fn test_oracle_submit_result_emits_event_player2_wins() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.submit_result(
            &2u64,
            &String::from_str(&env, "game_abc"),
            &MatchResult::Player2Wins,
        );

        let expected_topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("result").into_val(&env),
        ];

        let events = env.events().all();
        let matched = events
            .iter()
            .find(|(_, topics, _)| *topics == expected_topics);

        assert!(matched.is_some(), "No result event emitted for Player2Wins");

        let (_, _, actual_data) = matched.unwrap();
        let (ev_match_id, ev_game_id, ev_result): (u64, String, MatchResult) =
            soroban_sdk::TryFromVal::try_from_val(&env, &actual_data).unwrap();
        assert_eq!(ev_match_id, 2u64, "match_id mismatch for Player2Wins");
        assert_eq!(
            ev_game_id,
            String::from_str(&env, "game_abc"),
            "game_id mismatch for Player2Wins"
        );
        assert_eq!(
            ev_result,
            MatchResult::Player2Wins,
            "result mismatch for Player2Wins"
        );
    }

    #[test]
    fn test_oracle_submit_result_emits_event_draw() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.submit_result(
            &3u64,
            &String::from_str(&env, "game_abc"),
            &MatchResult::Draw,
        );

        let expected_topics = vec![
            &env,
            Symbol::new(&env, "oracle").into_val(&env),
            soroban_sdk::symbol_short!("result").into_val(&env),
        ];

        let events = env.events().all();
        let matched = events
            .iter()
            .find(|(_, topics, _)| *topics == expected_topics);

        assert!(matched.is_some(), "No result event emitted for Draw");

        let (_, _, actual_data) = matched.unwrap();
        let (ev_match_id, ev_game_id, ev_result): (u64, String, MatchResult) =
            soroban_sdk::TryFromVal::try_from_val(&env, &actual_data).unwrap();
        assert_eq!(ev_match_id, 3u64, "match_id mismatch for Draw");
        assert_eq!(
            ev_game_id,
            String::from_str(&env, "game_abc"),
            "game_id mismatch for Draw"
        );
        assert_eq!(ev_result, MatchResult::Draw, "result mismatch for Draw");
    }

    #[test]
    fn submit_result_long_game_id_returns_invalid() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        let long_game_id = String::from_str(&env, &"x".repeat(65));

        assert!(matches!(
            client.try_submit_result(&1u64, &long_game_id, &MatchResult::Player1Wins),
            Err(Ok(Error::InvalidGameId))
        ));
    }

    // ── Issue #1512: game_id character-set validation ─────────────────────────

    #[test]
    fn submit_result_game_id_with_null_byte_returns_invalid() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        // Null byte — would brick the escrow match with GameIdMismatch if stored.
        let bad_id = String::from_str(&env, "abc\x00def");
        assert_eq!(
            client.try_submit_result(&1u64, &bad_id, &MatchResult::Player1Wins),
            Err(Ok(Error::InvalidGameId)),
            "null byte in game_id must be rejected"
        );
    }

    #[test]
    fn submit_result_game_id_with_space_returns_invalid() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        let bad_id = String::from_str(&env, "abc def");
        assert_eq!(
            client.try_submit_result(&1u64, &bad_id, &MatchResult::Player1Wins),
            Err(Ok(Error::InvalidGameId)),
            "space in game_id must be rejected"
        );
    }

    #[test]
    fn submit_result_game_id_with_slash_returns_invalid() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        let bad_id = String::from_str(&env, "abc/def");
        assert_eq!(
            client.try_submit_result(&1u64, &bad_id, &MatchResult::Player1Wins),
            Err(Ok(Error::InvalidGameId)),
            "slash in game_id must be rejected"
        );
    }

    #[test]
    fn submit_result_game_id_with_at_symbol_returns_invalid() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        let bad_id = String::from_str(&env, "abc@def");
        assert_eq!(
            client.try_submit_result(&1u64, &bad_id, &MatchResult::Player1Wins),
            Err(Ok(Error::InvalidGameId)),
            "@ in game_id must be rejected"
        );
    }

    #[test]
    fn submit_result_game_id_valid_charset_accepted() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        // All allowed character classes: uppercase, lowercase, digits, underscore, hyphen.
        let valid_id = String::from_str(&env, "AbcXyz-012_ABC");
        assert!(
            client
                .try_submit_result(&1u64, &valid_id, &MatchResult::Player1Wins)
                .is_ok(),
            "valid [A-Za-z0-9_-] game_id must be accepted"
        );
    }

    #[test]
    fn submit_result_game_id_single_char_accepted() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        // Minimum valid length: 1 byte from the allowed set.
        let valid_id = String::from_str(&env, "a");
        assert!(
            client
                .try_submit_result(&2u64, &valid_id, &MatchResult::Draw)
                .is_ok(),
            "single allowed char must be accepted"
        );
    }

    #[test]
    fn submit_result_game_id_max_length_valid_charset_accepted() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        // 64 bytes of allowed characters — sits exactly on the length boundary.
        let valid_id = String::from_str(&env, &"a".repeat(64));
        assert!(
            client
                .try_submit_result(&3u64, &valid_id, &MatchResult::Player2Wins)
                .is_ok(),
            "64-char valid game_id must be accepted"
        );
    }

    #[test]
    fn get_result_nonexistent_returns_not_found() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        assert!(matches!(
            client.try_get_result(&999u64),
            Err(Ok(Error::ResultNotFound))
        ));
    }

    #[test]
    fn submit_result_duplicate_returns_already_submitted() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        client.submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw);

        assert!(matches!(
            client.try_submit_result(&0u64, &String::from_str(&env, "abc123"), &MatchResult::Draw),
            Err(Ok(Error::AlreadySubmitted))
        ));
    }

    // ── #1030: result count tracking ──────────────────────────────────────────

    #[test]
    fn test_get_result_count_starts_at_zero() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        assert_eq!(client.get_result_count(), 0u64);
    }

    #[test]
    fn test_get_result_count_increments_on_submit() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        client.submit_result(&0u64, &String::from_str(&env, "game1"), &MatchResult::Player1Wins);
        assert_eq!(client.get_result_count(), 1u64);

        client.submit_result(&1u64, &String::from_str(&env, "game2"), &MatchResult::Player2Wins);
        assert_eq!(client.get_result_count(), 2u64);

        client.submit_result(&5u64, &String::from_str(&env, "game5"), &MatchResult::Draw);
        assert_eq!(client.get_result_count(), 3u64, "count tracks submissions not match_ids");
    }

    #[test]
    fn test_list_results_empty() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        let results = client.list_results(&0u64, &10u32);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_list_results_returns_existing_entries() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        client.submit_result(&0u64, &String::from_str(&env, "game0"), &MatchResult::Player1Wins);
        client.submit_result(&1u64, &String::from_str(&env, "game1"), &MatchResult::Draw);
        // match_id 2 has no result — should be skipped
        client.submit_result(&3u64, &String::from_str(&env, "game3"), &MatchResult::Player2Wins);

        // ResultCount is 3, so only IDs 0..3 are scanned; ID 3 is outside the range.
        let results = client.list_results(&0u64, &10u32);
        assert_eq!(results.len(), 2, "should stop scanning at ResultCount");

        let ids: soroban_sdk::Vec<u64> = soroban_sdk::Vec::from_array(
            &env,
            [
                results.get(0).unwrap().0,
                results.get(1).unwrap().0,
            ],
        );
        assert_eq!(ids.get(0).unwrap(), 0u64);
        assert_eq!(ids.get(1).unwrap(), 1u64);
    }

    #[test]
    fn test_list_results_limit_capped_at_100() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        // Requesting 200 should return at most 100 IDs scanned (and 0 results in this case)
        let results = client.list_results(&0u64, &200u32);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_list_results_sparse_non_contiguous_id_space() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        // Submit results for non-contiguous match IDs, leaving large gaps.
        client.submit_result(&0u64, &String::from_str(&env, "game0"), &MatchResult::Player1Wins);
        client.submit_result(&5u64, &String::from_str(&env, "game5"), &MatchResult::Draw);
        client.submit_result(&10u64, &String::from_str(&env, "game10"), &MatchResult::Player2Wins);

        // Scan a window covering all three IDs plus the gaps between them.
        let results = client.list_results(&0u64, &20u32);
        assert_eq!(
            results.len(),
            3,
            "should return exactly the 3 submitted IDs and skip the gaps"
        );

        let ids: soroban_sdk::Vec<u64> = soroban_sdk::Vec::from_array(
            &env,
            [
                results.get(0).unwrap().0,
                results.get(1).unwrap().0,
                results.get(2).unwrap().0,
            ],
        );
        assert_eq!(ids.get(0).unwrap(), 0u64);
        assert_eq!(ids.get(1).unwrap(), 5u64);
        assert_eq!(ids.get(2).unwrap(), 10u64);

        // Starting the scan at a gap (id 1) must still find the later IDs (5 and 10).
        let from_gap = client.list_results(&1u64, &20u32);
        assert_eq!(from_gap.len(), 2);
        assert_eq!(from_gap.get(0).unwrap().0, 5u64);
        assert_eq!(from_gap.get(1).unwrap().0, 10u64);

        // Starting past the last submitted ID returns nothing.
        let past_end = client.list_results(&11u64, &20u32);
        assert_eq!(past_end.len(), 0);
    }

    // ── Issue #1513 / #1706: two-step admin transfer — zero address guard ────

    #[test]
    fn test_propose_admin_zero_address_returns_invalid_admin_and_contract_remains_operational() {
        let (env, contract_id) = setup();
        let client = OracleContractClient::new(&env, &contract_id);

        // The all-zeroes contract address (C-strkey) can never sign a transaction.
        // Passing it to propose_admin must return Error::InvalidAdmin.
        let zero_addr = Address::from_strkey(
            &env,
            &String::from_str(
                &env,
                "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
            ),
        );

        assert_eq!(
            client.try_propose_admin(&zero_addr),
            Err(Ok(Error::InvalidAdmin)),
            "propose_admin must reject the zero address with InvalidAdmin"
        );

        // Confirm the contract is still functional — no pending admin was stored.
        client.submit_result(
            &0u64,
            &String::from_str(&env, "game1"),
            &MatchResult::Player1Wins,
        );
        assert!(client.has_result(&0u64), "contract must remain operational after rejected proposal");
    }
}
