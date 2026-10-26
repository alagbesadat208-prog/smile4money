#![no_std]

mod errors;
mod types;

use errors::Error;
use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, String, Symbol, Vec};
use types::{Bracket, DataKey, Node, NodeState, Slot};

/// ~30 days at 5s/ledger. Used as both the TTL threshold and the extend-to value.
const BRACKET_TTL_LEDGERS: u32 = 518_400;

/// Largest supported bracket: 256 first round sides, 8 rounds.
pub const MAX_BRACKET_SIZE: u32 = 256;

/// Maximum allowed byte length for an external `game_id` string.
pub const MAX_GAME_ID_LEN: u32 = 64;

/// Default review window in ledgers (~10 minutes at 5s/ledger) during which a
/// reported match result remains in [`NodeState::UnderReview`] and can be
/// amended by the bracket's authorized reviewer before becoming final.
pub const DEFAULT_REVIEW_WINDOW_LEDGERS: u32 = 120;

/// A tournament bracket.
///
/// The bracket is a fixed size elimination tree: round `0` holds `size / 2`
/// nodes, every following round halves the number of nodes and the last round
/// holds the final. A node of round `r` and index `i` feeds the node of round
/// `r + 1` and index `i / 2`, into its first side when `i` is even and into
/// its second side when `i` is odd.
///
/// Byes are explicit. Every side of a node is either occupied by a
/// participant, sealed as a bye or still vacant, and the three cases are never
/// mixed up:
///
/// * A **bye node** has one side sealed as a bye and one side occupied. The
///   participant advances into the next round without playing.
/// * A **void node** has both sides sealed as byes. Nobody advances and the
///   next round receives an explicit bye for that side.
/// * An **unfilled node** still has a vacant side. It is neither a bye nor a
///   void: it is simply not decided yet and cannot be played.
///
/// ## Node Game Identifiers
///
/// Each playable node can be bound to a unique external `game_id` within its
/// tournament via [`BracketContract::set_node_game_id`] or when reporting a
/// result via [`BracketContract::submit_result_with_game_id`]:
///
/// * Duplicate `game_id` values within the same tournament are rejected with
///   [`Error::DuplicateGameId`].
/// * Empty or oversized (`> 64` bytes) identifiers are rejected with
///   [`Error::InvalidGameId`].
/// * Once a node is finalized ([`NodeState::Resolved`]), its `game_id` is
///   immutable and any attempt to replace it fails with
///   [`Error::AlreadyResolved`].
/// * Reporting a result with a `game_id` that disagrees with the node's bound
///   identifier fails with [`Error::GameIdMismatch`].
///
/// ## Distinct-Participant Invariant
///
/// No participant may occupy more than one slot in a bracket or both sides of
/// the same node:
///
/// * Bracket construction ([`BracketContract::create_seeded_bracket`]) and
///   registration ([`BracketContract::register`]) reject duplicate participant
///   addresses and prevent identical addresses from being placed into `slot1`
///   and `slot2`.
/// * Advancement ([`BracketContract::write_parent_slot`]) verifies that the
///   opposite side of the parent node does not already hold the advancing
///   participant, failing with [`Error::DuplicateParticipant`] before mutating
///   storage.
/// * Any stored node whose `slot1` and `slot2` hold the same participant is
///   rejected as [`Error::MalformedNode`].
///
/// ## Result Review Window
///
/// Reporting a match outcome via [`BracketContract::submit_result`] or
/// [`BracketContract::submit_result_with_game_id`] does not immediately advance
/// the player. Instead, the node enters [`NodeState::UnderReview`] with a
/// deadline of `env.ledger().sequence() + bracket.review_window_ledgers`
/// (defaulting to [`DEFAULT_REVIEW_WINDOW_LEDGERS`] and configurable via
/// [`BracketContract::set_review_config`]):
///
/// * While `env.ledger().sequence() < review_deadline`:
///   - Only `bracket.reviewer` can call [`BracketContract::amend_result`] to
///     correct a contested provisional winner.
///   - Advancement to the parent round is blocked and
///     [`BracketContract::finalize_result`] fails with
///     [`Error::ReviewWindowOpen`].
/// * Once `env.ledger().sequence() >= review_deadline`:
///   - [`BracketContract::amend_result`] is rejected with
///     [`Error::ReviewWindowExpired`].
///   - [`BracketContract::finalize_result`] transitions the node to
///     [`NodeState::Resolved`] and advances the winner into the next round.
///
/// ## Emergency Mode
///
/// The contract admin can place the contract into emergency mode via
/// [`BracketContract::pause`] and lift it via [`BracketContract::unpause`]:
///
/// * **Blocked while paused** ([`Error::ContractPaused`]):
///   - [`BracketContract::create_bracket`]
///   - [`BracketContract::create_seeded_bracket`]
///   - [`BracketContract::create_paid_bracket`]
///   - [`BracketContract::set_review_config`]
///   - [`BracketContract::set_node_game_id`]
///   - [`BracketContract::register`]
///   - [`BracketContract::lock_registration`]
///   - [`BracketContract::submit_result`]
///   - [`BracketContract::submit_result_with_game_id`]
///   - [`BracketContract::amend_result`]
///   - [`BracketContract::finalize_result`]
///   - [`BracketContract::advance_bye`]
/// * **Allowed while paused** (participant exits, cancellation, recovery, and reads):
///   - [`BracketContract::withdraw`] — registered participants can exit any
///     incomplete bracket and immediately receive their entry fee refund, even
///     if the bracket was already locked before the incident.
///   - [`BracketContract::cancel_bracket`] — admin can permanently cancel an
///     incomplete bracket so participants remain able to withdraw even after
///     emergency mode is lifted.
///   - [`BracketContract::unpause`] — admin can lift emergency mode.
///   - Read queries (`is_paused`, `get_bracket`, `get_node`,
///     `get_node_by_game_id`, `get_node_state`, `get_champion`).
#[contract]
pub struct BracketContract;

#[contractimpl]
impl BracketContract {
    /// Initialize the contract with the address allowed to manage brackets.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::BracketCount, &0u64);
        env.events()
            .publish((Symbol::new(&env, "bracket"), symbol_short!("init")), admin);
        Ok(())
    }

    /// Activate emergency mode — admin only.
    ///
    /// Blocks all tournament creation and progression while keeping
    /// `cancel_bracket`, `withdraw`, `unpause`, and all read queries available.
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("paused")),
            admin,
        );
        Ok(())
    }

    /// Lift emergency mode — admin only.
    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("unpaused")),
            admin,
        );
        Ok(())
    }

    /// Return whether emergency pause mode is currently active.
    pub fn is_paused(env: Env) -> bool {
        Self::paused(&env)
    }

    /// Create a free bracket with `size` first round sides and the default
    /// review window ([`DEFAULT_REVIEW_WINDOW_LEDGERS`]).
    ///
    /// `size` must be a power of two: every round halves the number of nodes
    /// and the last round holds the final.
    pub fn create_bracket(env: Env, size: u32) -> Result<u64, Error> {
        Self::create_bracket_internal(&env, size, None, 0)
    }

    /// Create a bracket pre-seeded with `participants` in round `0`.
    ///
    /// Rejects duplicate participant addresses (including identical addresses
    /// across both slots of any node) with [`Error::DuplicateParticipant`].
    pub fn create_seeded_bracket(
        env: Env,
        size: u32,
        participants: Vec<Address>,
    ) -> Result<u64, Error> {
        if participants.len() > size {
            return Err(Error::BracketFull);
        }

        // Reject any duplicate participant before creating or mutating state.
        let count = participants.len();
        for i in 0..count {
            let p_i = participants.get(i).unwrap();
            for j in (i + 1)..count {
                let p_j = participants.get(j).unwrap();
                if p_i == p_j {
                    return Err(Error::DuplicateParticipant);
                }
            }
        }

        let bracket_id = Self::create_bracket_internal(&env, size, None, 0)?;
        let mut bracket = Self::load_bracket(&env, bracket_id)?;

        for side in 0..count {
            let participant = participants.get(side).unwrap();
            let node_id = Self::node_id(size, 0, side / 2);
            let mut node = Self::load_node(&env, bracket_id, node_id)?;
            Self::assign_node_side(&mut node, side % 2, participant)?;
            Self::save_node(&env, &node);
            bracket.registered += 1;
        }

        Self::save_bracket(&env, &bracket);
        Ok(bracket_id)
    }

    /// Create a bracket with an escrowed `entry_fee` in `token` per participant.
    ///
    /// Participants transfer `entry_fee` on [`BracketContract::register`] and
    /// receive a full refund on [`BracketContract::withdraw`].
    pub fn create_paid_bracket(
        env: Env,
        size: u32,
        token: Address,
        entry_fee: i128,
    ) -> Result<u64, Error> {
        if entry_fee <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::create_bracket_internal(&env, size, Some(token), entry_fee)
    }

    /// Configure the authorized `reviewer` and `review_window_ledgers` for a
    /// bracket — bracket admin only.
    ///
    /// `review_window_ledgers` must be greater than zero so that reported
    /// results always pass through a reviewable window before finalization.
    pub fn set_review_config(
        env: Env,
        bracket_id: u64,
        reviewer: Address,
        review_window_ledgers: u32,
        caller: Address,
    ) -> Result<(), Error> {
        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }
        if review_window_ledgers == 0 {
            return Err(Error::InvalidReviewWindow);
        }

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }
        if bracket.champion.is_some() {
            return Err(Error::AlreadyCompleted);
        }

        bracket.reviewer = reviewer.clone();
        bracket.review_window_ledgers = review_window_ledgers;
        Self::save_bracket(&env, &bracket);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("review")),
            (bracket_id, reviewer, review_window_ledgers),
        );

        Ok(())
    }

    /// Associate a unique external `game_id` with a playable bracket node —
    /// bracket admin only.
    ///
    /// * Rejects empty or oversized (`> MAX_GAME_ID_LEN`) identifiers with
    ///   [`Error::InvalidGameId`].
    /// * Rejects `game_id` values already used in the same bracket with
    ///   [`Error::DuplicateGameId`].
    /// * Rejects attempts to replace a finalized ([`NodeState::Resolved`])
    ///   node's `game_id` with [`Error::AlreadyResolved`].
    /// * Rejects non-playable (`ByeAdvance`, `Void`) or unfilled
    ///   (`AwaitingParticipants`) nodes with [`Error::NotPlayable`] /
    ///   [`Error::SlotVacant`].
    pub fn set_node_game_id(
        env: Env,
        bracket_id: u64,
        node_id: u64,
        game_id: String,
        caller: Address,
    ) -> Result<(), Error> {
        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }
        Self::validate_game_id(&game_id)?;

        let bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }

        let mut node = Self::load_node(&env, bracket_id, node_id)?;
        match Self::node_state(&node, &bracket)? {
            NodeState::AwaitingParticipants => return Err(Error::SlotVacant),
            NodeState::ByeAdvance(_) | NodeState::Void => return Err(Error::NotPlayable),
            NodeState::Resolved(_) => return Err(Error::AlreadyResolved),
            NodeState::Ready | NodeState::UnderReview(_, _) => {}
        }

        Self::bind_game_id(&env, bracket_id, &mut node, game_id.clone())?;
        Self::save_node(&env, &node);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("game_id")),
            (bracket_id, node_id, game_id),
        );

        Ok(())
    }

    /// Register `participant` in the next free side of the first round.
    ///
    /// Sides are handed out in order of the first vacant slot. A participant
    /// can only take one side of a bracket. Blocked while emergency mode is
    /// active or if the bracket has been cancelled.
    pub fn register(env: Env, bracket_id: u64, participant: Address) -> Result<(), Error> {
        participant.require_auth();

        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }
        if bracket.locked {
            return Err(Error::RegistrationClosed);
        }
        if bracket.registered >= bracket.size {
            return Err(Error::BracketFull);
        }
        if Self::find_participant(&env, &bracket, &participant).is_some() {
            return Err(Error::AlreadyRegistered);
        }

        let side = Self::first_vacant_side(&env, &bracket)?.ok_or(Error::BracketFull)?;
        let node_id = Self::node_id(bracket.size, 0, side / 2);
        let mut node = Self::load_node(&env, bracket_id, node_id)?;
        Self::assign_node_side(&mut node, side % 2, participant.clone())?;

        if let Some(ref token_addr) = bracket.token {
            if bracket.entry_fee > 0 {
                let token_client = token::Client::new(&env, token_addr);
                token_client.transfer(
                    &participant,
                    &env.current_contract_address(),
                    &bracket.entry_fee,
                );
            }
        }

        Self::save_node(&env, &node);
        bracket.registered += 1;
        Self::save_bracket(&env, &bracket);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("entered")),
            (bracket_id, participant),
        );

        Ok(())
    }

    /// Close registration and seal every vacant side of the first round as an
    /// explicit bye.
    ///
    /// From this point on a vacant side no longer means "registration is
    /// open": every side of the first round is either occupied or a bye. The
    /// byes advance on their own while the bracket is sealed.
    pub fn lock_registration(env: Env, bracket_id: u64, caller: Address) -> Result<(), Error> {
        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }
        if bracket.locked {
            return Err(Error::AlreadyLocked);
        }

        for index in 0..Self::nodes_in_round(bracket.size, 0) {
            let node_id = Self::node_id(bracket.size, 0, index);
            let mut node = Self::load_node(&env, bracket_id, node_id)?;
            if node.slot1 == Slot::Vacant {
                node.slot1 = Slot::Bye;
            }
            if node.slot2 == Slot::Vacant {
                node.slot2 = Slot::Bye;
            }
            Self::save_node(&env, &node);
        }

        bracket.locked = true;
        Self::save_bracket(&env, &bracket);

        // Byes advance without anybody having to ask for it.
        for index in 0..Self::nodes_in_round(bracket.size, 0) {
            let node_id = Self::node_id(bracket.size, 0, index);
            Self::settle_from(&env, &mut bracket, node_id)?;
        }

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("locked")),
            bracket_id,
        );

        Ok(())
    }

    /// Report the provisional winner of a match and start its review window.
    ///
    /// The node enters [`NodeState::UnderReview`] until
    /// `env.ledger().sequence() + bracket.review_window_ledgers`. Advancement
    /// into the next round is blocked until the review window expires and
    /// [`BracketContract::finalize_result`] is called.
    pub fn submit_result(
        env: Env,
        bracket_id: u64,
        node_id: u64,
        winner: Address,
        caller: Address,
    ) -> Result<(), Error> {
        Self::submit_result_internal(&env, bracket_id, node_id, None, winner, caller)
    }

    /// Report the provisional winner of a match while verifying or persisting
    /// the node's external `game_id`.
    ///
    /// * If the node already has a `game_id`, `game_id` must match it or the
    ///   call fails with [`Error::GameIdMismatch`].
    /// * If the node does not yet have a `game_id`, `game_id` is validated for
    ///   uniqueness within the bracket (`Error::DuplicateGameId`) and stored on
    ///   the node.
    pub fn submit_result_with_game_id(
        env: Env,
        bracket_id: u64,
        node_id: u64,
        game_id: String,
        winner: Address,
        caller: Address,
    ) -> Result<(), Error> {
        Self::submit_result_internal(&env, bracket_id, node_id, Some(game_id), winner, caller)
    }

    /// Amend a provisional match result while its review window is still open.
    ///
    /// Only the bracket's authorized `reviewer` may call this function, and
    /// only strictly before `review_deadline` (`env.ledger().sequence() < deadline`).
    pub fn amend_result(
        env: Env,
        bracket_id: u64,
        node_id: u64,
        new_winner: Address,
        caller: Address,
    ) -> Result<(), Error> {
        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }

        let bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.reviewer {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }

        let mut node = Self::load_node(&env, bracket_id, node_id)?;
        match Self::node_state(&node, &bracket)? {
            NodeState::UnderReview(_, deadline) => {
                if env.ledger().sequence() >= deadline {
                    return Err(Error::ReviewWindowExpired);
                }
            }
            NodeState::Resolved(_) => return Err(Error::AlreadyResolved),
            _ => return Err(Error::NotUnderReview),
        }

        let is_participant = matches!(&node.slot1, Slot::Filled(a) if *a == new_winner)
            || matches!(&node.slot2, Slot::Filled(a) if *a == new_winner);
        if !is_participant {
            return Err(Error::InvalidWinner);
        }

        node.pending_winner = Some(new_winner.clone());
        Self::save_node(&env, &node);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("amended")),
            (bracket_id, node_id, new_winner),
        );

        Ok(())
    }

    /// Finalize a reviewed match result once its review deadline has passed and
    /// advance the winner in the bracket.
    pub fn finalize_result(env: Env, bracket_id: u64, node_id: u64) -> Result<(), Error> {
        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }

        let mut node = Self::load_node(&env, bracket_id, node_id)?;
        let winner = match Self::node_state(&node, &bracket)? {
            NodeState::UnderReview(provisional_winner, deadline) => {
                if env.ledger().sequence() < deadline {
                    return Err(Error::ReviewWindowOpen);
                }
                provisional_winner
            }
            NodeState::Resolved(_) => return Err(Error::AlreadyResolved),
            _ => return Err(Error::NotUnderReview),
        };

        node.pending_winner = None;
        node.review_deadline = None;
        node.winner = Some(winner.clone());
        Self::save_node(&env, &node);

        // Now that the result is final, advance the winner into the next round.
        Self::settle_from(&env, &mut bracket, node_id)?;

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("resolved")),
            (bracket_id, node_id, winner),
        );

        Ok(())
    }

    /// Advance the participant of a bye node into the next round.
    ///
    /// Byes advance automatically when the bracket is sealed and when a result
    /// is finalized. This entry point only makes the rule explicit, it is
    /// idempotent and it rejects a node that is not a bye.
    pub fn advance_bye(env: Env, bracket_id: u64, node_id: u64) -> Result<(), Error> {
        if Self::paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }
        let node = Self::load_node(&env, bracket_id, node_id)?;

        match Self::node_state(&node, &bracket)? {
            NodeState::ByeAdvance(_) => {}
            // Not decided yet: an unfilled node is not a bye.
            NodeState::AwaitingParticipants => return Err(Error::SlotVacant),
            NodeState::Void
            | NodeState::Ready
            | NodeState::UnderReview(_, _)
            | NodeState::Resolved(_) => return Err(Error::NotABye),
        }

        Self::settle_from(&env, &mut bracket, node_id)?;

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("advance")),
            (bracket_id, node_id),
        );

        Ok(())
    }

    /// Cancel an incomplete bracket — admin only.
    ///
    /// Available both during normal operation and while emergency mode is
    /// active (`is_paused() == true`). Once cancelled, the bracket can never
    /// resume progression, and all registered participants can call
    /// [`BracketContract::withdraw`] to exit and claim their refund.
    pub fn cancel_bracket(env: Env, bracket_id: u64, caller: Address) -> Result<(), Error> {
        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if bracket.champion.is_some() {
            return Err(Error::AlreadyCompleted);
        }
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }

        bracket.cancelled = true;
        Self::save_bracket(&env, &bracket);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("cancel")),
            bracket_id,
        );

        Ok(())
    }

    /// Exit a bracket and refund any escrowed entry fee to `participant`.
    ///
    /// Allowed when:
    /// * Registration is still open (`!bracket.locked`), OR
    /// * The bracket has been cancelled (`bracket.cancelled`), OR
    /// * The contract is in emergency mode (`is_paused() == true`) and the
    ///   bracket has not completed (`bracket.champion.is_none()`).
    ///
    /// If a participant withdraws from a locked bracket while emergency mode is
    /// active, the bracket is also marked `cancelled` so that partial state
    /// cannot resume if the contract is later unpaused.
    pub fn withdraw(env: Env, bracket_id: u64, participant: Address) -> Result<(), Error> {
        participant.require_auth();

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if bracket.champion.is_some() {
            return Err(Error::AlreadyCompleted);
        }

        let can_exit = !bracket.locked || bracket.cancelled || Self::paused(&env);
        if !can_exit {
            return Err(Error::RegistrationClosed);
        }

        let side =
            Self::find_participant(&env, &bracket, &participant).ok_or(Error::NotRegistered)?;
        let node_id = Self::node_id(bracket.size, 0, side / 2);
        let mut node = Self::load_node(&env, bracket_id, node_id)?;

        let replacement = if bracket.locked {
            bracket.cancelled = true;
            Slot::Bye
        } else {
            Slot::Vacant
        };

        if side % 2 == 0 {
            node.slot1 = replacement;
        } else {
            node.slot2 = replacement;
        }

        if let Some(ref token_addr) = bracket.token {
            if bracket.entry_fee > 0 {
                let token_client = token::Client::new(&env, token_addr);
                token_client.transfer(
                    &env.current_contract_address(),
                    &participant,
                    &bracket.entry_fee,
                );
            }
        }

        Self::save_node(&env, &node);
        bracket.registered = bracket.registered.saturating_sub(1);
        Self::save_bracket(&env, &bracket);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("withdrew")),
            (bracket_id, participant),
        );

        Ok(())
    }

    /// Read a bracket by id.
    pub fn get_bracket(env: Env, bracket_id: u64) -> Result<Bracket, Error> {
        Self::load_bracket(&env, bracket_id)
    }

    /// Read a node by id.
    pub fn get_node(env: Env, bracket_id: u64, node_id: u64) -> Result<Node, Error> {
        Self::load_node(&env, bracket_id, node_id)
    }

    /// Read a node by its bound external `game_id` within `bracket_id`.
    pub fn get_node_by_game_id(env: Env, bracket_id: u64, game_id: String) -> Result<Node, Error> {
        let node_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::GameId(bracket_id, game_id))
            .ok_or(Error::NotFound)?;
        Self::load_node(&env, bracket_id, node_id)
    }

    /// Read the state of a node.
    ///
    /// The state tells a bye apart from a node that is still waiting for
    /// participants and from a node whose stored state is corrupted.
    pub fn get_node_state(env: Env, bracket_id: u64, node_id: u64) -> Result<NodeState, Error> {
        let bracket = Self::load_bracket(&env, bracket_id)?;
        let node = Self::load_node(&env, bracket_id, node_id)?;
        Self::node_state(&node, &bracket)
    }

    /// Read the champion of a bracket.
    pub fn get_champion(env: Env, bracket_id: u64) -> Result<Address, Error> {
        let bracket = Self::load_bracket(&env, bracket_id)?;
        bracket.champion.ok_or(Error::NotFound)
    }

    fn paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<Address, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if *caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Ok(admin)
    }

    fn validate_game_id(game_id: &String) -> Result<(), Error> {
        if game_id.is_empty() || game_id.len() > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }
        Ok(())
    }

    fn bind_game_id(
        env: &Env,
        bracket_id: u64,
        node: &mut Node,
        game_id: String,
    ) -> Result<(), Error> {
        let key = DataKey::GameId(bracket_id, game_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateGameId);
        }

        if let Some(ref previous_game_id) = node.game_id {
            let old_key = DataKey::GameId(bracket_id, previous_game_id.clone());
            env.storage().persistent().remove(&old_key);
        }

        env.storage().persistent().set(&key, &node.node_id);
        env.storage()
            .persistent()
            .extend_ttl(&key, BRACKET_TTL_LEDGERS, BRACKET_TTL_LEDGERS);
        node.game_id = Some(game_id);
        Ok(())
    }

    fn submit_result_internal(
        env: &Env,
        bracket_id: u64,
        node_id: u64,
        game_id: Option<String>,
        winner: Address,
        caller: Address,
    ) -> Result<(), Error> {
        if Self::paused(env) {
            return Err(Error::ContractPaused);
        }

        let bracket = Self::load_bracket(env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        if bracket.cancelled {
            return Err(Error::BracketCancelled);
        }

        let mut node = Self::load_node(env, bracket_id, node_id)?;
        match Self::node_state(&node, &bracket)? {
            // The node is not decided yet, it is not a bye either.
            NodeState::AwaitingParticipants => return Err(Error::SlotVacant),
            // A bye or a void node is never played.
            NodeState::ByeAdvance(_) | NodeState::Void => return Err(Error::NotPlayable),
            NodeState::UnderReview(_, _) | NodeState::Resolved(_) => {
                return Err(Error::AlreadyResolved)
            }
            NodeState::Ready => {}
        }

        let is_participant = matches!(&node.slot1, Slot::Filled(a) if *a == winner)
            || matches!(&node.slot2, Slot::Filled(a) if *a == winner);
        if !is_participant {
            return Err(Error::InvalidWinner);
        }

        if let Some(provided_game_id) = game_id {
            Self::validate_game_id(&provided_game_id)?;
            match &node.game_id {
                Some(existing) if *existing != provided_game_id => {
                    return Err(Error::GameIdMismatch);
                }
                Some(_) => {}
                None => {
                    Self::bind_game_id(env, bracket_id, &mut node, provided_game_id)?;
                }
            }
        }

        let deadline = env
            .ledger()
            .sequence()
            .checked_add(bracket.review_window_ledgers)
            .ok_or(Error::Overflow)?;

        node.pending_winner = Some(winner.clone());
        node.review_deadline = Some(deadline);
        Self::save_node(env, &node);

        env.events().publish(
            (Symbol::new(env, "bracket"), symbol_short!("reported")),
            (bracket_id, node_id, winner, deadline),
        );

        Ok(())
    }

    fn assign_node_side(node: &mut Node, side: u32, participant: Address) -> Result<(), Error> {
        let opposite = if side == 0 { &node.slot2 } else { &node.slot1 };
        if matches!(opposite, Slot::Filled(existing) if *existing == participant) {
            return Err(Error::DuplicateParticipant);
        }
        if side == 0 {
            node.slot1 = Slot::Filled(participant);
        } else {
            node.slot2 = Slot::Filled(participant);
        }
        Ok(())
    }

    fn create_bracket_internal(
        env: &Env,
        size: u32,
        token: Option<Address>,
        entry_fee: i128,
    ) -> Result<u64, Error> {
        if Self::paused(env) {
            return Err(Error::ContractPaused);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        if size < 2 || size > MAX_BRACKET_SIZE || !size.is_power_of_two() {
            return Err(Error::InvalidSize);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BracketCount)
            .unwrap_or(0);
        let rounds = size.trailing_zeros();
        let bracket = Bracket {
            id,
            admin: admin.clone(),
            reviewer: admin,
            review_window_ledgers: DEFAULT_REVIEW_WINDOW_LEDGERS,
            size,
            rounds,
            registered: 0,
            locked: false,
            cancelled: false,
            token,
            entry_fee,
            champion: None,
        };

        // Nobody is seeded yet: every side of every node starts vacant.
        for round in 0..rounds {
            for index in 0..Self::nodes_in_round(size, round) {
                let node = Node {
                    bracket_id: id,
                    node_id: Self::node_id(size, round, index),
                    round,
                    index,
                    slot1: Slot::Vacant,
                    slot2: Slot::Vacant,
                    game_id: None,
                    pending_winner: None,
                    review_deadline: None,
                    winner: None,
                };
                Self::save_node(env, &node);
            }
        }

        Self::save_bracket(env, &bracket);
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::BracketCount, &next_id);

        env.events().publish(
            (Symbol::new(env, "bracket"), symbol_short!("created")),
            (id, size),
        );

        Ok(id)
    }

    /// Derive the state of a node from its sides and result fields.
    ///
    /// This is the only place where the bracket rules are decided. Anything
    /// that cannot be read as one of the states below is reported as
    /// [`Error::MalformedNode`] instead of being interpreted.
    fn node_state(node: &Node, bracket: &Bracket) -> Result<NodeState, Error> {
        match (&node.slot1, &node.slot2) {
            // At least one side is still open. In a sealed first round that
            // cannot happen: every side was either taken or sealed as a bye.
            (Slot::Vacant, _) | (_, Slot::Vacant) => {
                if bracket.locked && node.round == 0 {
                    return Err(Error::MalformedNode);
                }
                if node.winner.is_some()
                    || node.pending_winner.is_some()
                    || node.review_deadline.is_some()
                    || node.game_id.is_some()
                {
                    return Err(Error::MalformedNode);
                }
                Ok(NodeState::AwaitingParticipants)
            }
            (Slot::Filled(p1), Slot::Filled(p2)) => {
                if p1 == p2 {
                    // Nobody plays against themselves.
                    return Err(Error::MalformedNode);
                }
                if let Some(ref gid) = node.game_id {
                    if Self::validate_game_id(gid).is_err() {
                        return Err(Error::MalformedNode);
                    }
                }
                match (&node.winner, &node.pending_winner, node.review_deadline) {
                    (Some(w), None, None) if w == p1 || w == p2 => {
                        Ok(NodeState::Resolved(w.clone()))
                    }
                    (None, Some(pw), Some(deadline)) if pw == p1 || pw == p2 => {
                        Ok(NodeState::UnderReview(pw.clone(), deadline))
                    }
                    (None, None, None) => Ok(NodeState::Ready),
                    _ => Err(Error::MalformedNode),
                }
            }
            // One side is a bye: the participant advances without playing.
            (Slot::Filled(p), Slot::Bye) | (Slot::Bye, Slot::Filled(p)) => {
                if node.winner.is_some()
                    || node.pending_winner.is_some()
                    || node.review_deadline.is_some()
                    || node.game_id.is_some()
                {
                    // A bye node is never played, so it cannot carry a winner or game_id.
                    return Err(Error::MalformedNode);
                }
                Ok(NodeState::ByeAdvance(p.clone()))
            }
            // Both sides are byes: nobody advances out of this node.
            (Slot::Bye, Slot::Bye) => {
                if node.winner.is_some()
                    || node.pending_winner.is_some()
                    || node.review_deadline.is_some()
                    || node.game_id.is_some()
                {
                    return Err(Error::MalformedNode);
                }
                Ok(NodeState::Void)
            }
        }
    }

    /// Propagate the automatic result of a node up the bracket.
    ///
    /// A bye node hands its participant to the next round, a void node hands
    /// an explicit bye to the next round and a resolved node hands its winner
    /// over. The cascade stops as soon as a node is still waiting for
    /// participants, is ready to be played, or is still under review.
    fn settle_from(env: &Env, bracket: &mut Bracket, node_id: u64) -> Result<(), Error> {
        let size = bracket.size;
        let rounds = bracket.rounds;
        let mut current = node_id;

        loop {
            let node = Self::load_node(env, bracket.id, current)?;
            let state = Self::node_state(&node, bracket)?;

            let contribution = match state {
                NodeState::AwaitingParticipants
                | NodeState::Ready
                | NodeState::UnderReview(_, _) => return Ok(()),
                NodeState::ByeAdvance(participant) => Slot::Filled(participant),
                NodeState::Void => Slot::Bye,
                NodeState::Resolved(winner) => Slot::Filled(winner),
            };

            let (parent_id, side) = match Self::parent_of(size, rounds, &node) {
                Some(parent) => parent,
                // Last round: the node decides the champion.
                None => {
                    if let Slot::Filled(champion) = contribution {
                        if bracket.champion.is_none() {
                            if let Some(ref token_addr) = bracket.token {
                                let prize = bracket.entry_fee * (bracket.registered as i128);
                                if prize > 0 {
                                    let token_client = token::Client::new(env, token_addr);
                                    token_client.transfer(
                                        &env.current_contract_address(),
                                        &champion,
                                        &prize,
                                    );
                                }
                            }
                        }
                        bracket.champion = Some(champion);
                        Self::save_bracket(env, bracket);
                    }
                    return Ok(());
                }
            };

            Self::write_parent_slot(env, bracket.id, parent_id, side, contribution)?;
            current = parent_id;
        }
    }

    /// Write the contribution of a node into the side of its parent it feeds.
    ///
    /// Enforces the invariant that the two sides of a parent node never hold
    /// identical participant addresses.
    fn write_parent_slot(
        env: &Env,
        bracket_id: u64,
        parent_id: u64,
        side: u32,
        value: Slot,
    ) -> Result<(), Error> {
        let mut parent = Self::load_node(env, bracket_id, parent_id)?;
        let (current, opposite) = if side == 0 {
            (&parent.slot1, &parent.slot2)
        } else {
            (&parent.slot2, &parent.slot1)
        };

        if let (Slot::Filled(incoming), Slot::Filled(other)) = (&value, opposite) {
            if incoming == other {
                return Err(Error::DuplicateParticipant);
            }
        }

        match (current, &value) {
            (Slot::Vacant, _) => {}
            // Already propagated.
            (Slot::Bye, Slot::Bye) => return Ok(()),
            (Slot::Filled(a), Slot::Filled(b)) if a == b => return Ok(()),
            // The parent side already holds somebody else.
            _ => return Err(Error::MalformedNode),
        }

        if side == 0 {
            parent.slot1 = value;
        } else {
            parent.slot2 = value;
        }
        Self::save_node(env, &parent);

        Ok(())
    }

    /// Number of nodes in `round` of a bracket with `size` first round sides.
    fn nodes_in_round(size: u32, round: u32) -> u32 {
        size >> (round + 1)
    }

    /// Flat id of the first node of `round`.
    fn round_offset(size: u32, round: u32) -> u32 {
        size - (size >> round)
    }

    /// Flat id of the node at `index` of `round`.
    fn node_id(size: u32, round: u32, index: u32) -> u64 {
        (Self::round_offset(size, round) + index) as u64
    }

    /// Parent node of a node and the side of the parent it feeds.
    fn parent_of(size: u32, rounds: u32, node: &Node) -> Option<(u64, u32)> {
        if node.round + 1 >= rounds {
            return None;
        }
        let parent_round = node.round + 1;
        let parent_index = node.index / 2;
        let side = node.index % 2;
        Some((Self::node_id(size, parent_round, parent_index), side))
    }

    /// First vacant side in round `0`, if any.
    fn first_vacant_side(env: &Env, bracket: &Bracket) -> Result<Option<u32>, Error> {
        for index in 0..Self::nodes_in_round(bracket.size, 0) {
            let node_id = Self::node_id(bracket.size, 0, index);
            let node = Self::load_node(env, bracket.id, node_id)?;
            if node.slot1 == Slot::Vacant {
                return Ok(Some(index * 2));
            }
            if node.slot2 == Slot::Vacant {
                return Ok(Some(index * 2 + 1));
            }
        }
        Ok(None)
    }

    /// Side of the first round occupied by `participant`, if any.
    fn find_participant(env: &Env, bracket: &Bracket, participant: &Address) -> Option<u32> {
        for index in 0..Self::nodes_in_round(bracket.size, 0) {
            let node_id = Self::node_id(bracket.size, 0, index);
            let node = Self::load_node(env, bracket.id, node_id).ok()?;
            if matches!(&node.slot1, Slot::Filled(a) if a == participant) {
                return Some(index * 2);
            }
            if matches!(&node.slot2, Slot::Filled(a) if a == participant) {
                return Some(index * 2 + 1);
            }
        }
        None
    }

    fn load_bracket(env: &Env, bracket_id: u64) -> Result<Bracket, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Bracket(bracket_id))
            .ok_or(Error::NotFound)
    }

    fn save_bracket(env: &Env, bracket: &Bracket) {
        let key = DataKey::Bracket(bracket.id);
        env.storage().persistent().set(&key, bracket);
        env.storage()
            .persistent()
            .extend_ttl(&key, BRACKET_TTL_LEDGERS, BRACKET_TTL_LEDGERS);
    }

    fn load_node(env: &Env, bracket_id: u64, node_id: u64) -> Result<Node, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Node(bracket_id, node_id))
            .ok_or(Error::NotFound)
    }

    fn save_node(env: &Env, node: &Node) {
        let key = DataKey::Node(node.bracket_id, node.node_id);
        env.storage().persistent().set(&key, node);
        env.storage()
            .persistent()
            .extend_ttl(&key, BRACKET_TTL_LEDGERS, BRACKET_TTL_LEDGERS);
    }
}

#[cfg(test)]
mod tests;
