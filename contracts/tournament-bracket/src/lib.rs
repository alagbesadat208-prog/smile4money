#![no_std]

mod errors;
mod types;

use errors::Error;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};
use types::{Bracket, DataKey, Node, NodeState, Slot};

/// ~30 days at 5s/ledger. Used as both the TTL threshold and the extend-to value.
const BRACKET_TTL_LEDGERS: u32 = 518_400;

/// Largest supported bracket: 256 first round sides, 8 rounds.
const MAX_BRACKET_SIZE: u32 = 256;

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
/// A node whose recorded sides and recorded winner disagree is malformed and
/// every operation on it fails with [`Error::MalformedNode`] instead of
/// guessing what the state was meant to be.
#[contract]
pub struct BracketContract;

#[contractimpl]
impl BracketContract {
    /// Initialize the contract with the address allowed to create brackets.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::BracketCount, &0u64);
        env.events()
            .publish((Symbol::new(&env, "bracket"), symbol_short!("init")), admin);
        Ok(())
    }

    /// Create a bracket with `size` first round sides.
    ///
    /// `size` must be a power of two: every round halves the number of nodes
    /// and the last round holds the final.
    pub fn create_bracket(env: Env, size: u32) -> Result<u64, Error> {
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
            admin,
            size,
            rounds,
            registered: 0,
            locked: false,
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
                    winner: None,
                };
                Self::save_node(&env, &node);
            }
        }

        Self::save_bracket(&env, &bracket);
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::BracketCount, &next_id);

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("created")),
            (id, size),
        );

        Ok(id)
    }

    /// Register `participant` in the next free side of the first round.
    ///
    /// Sides are handed out in registration order. A participant can only take
    /// one side of a bracket.
    pub fn register(env: Env, bracket_id: u64, participant: Address) -> Result<(), Error> {
        participant.require_auth();

        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if bracket.locked {
            return Err(Error::RegistrationClosed);
        }
        if bracket.registered >= bracket.size {
            return Err(Error::BracketFull);
        }
        if Self::find_participant(&env, &bracket, &participant).is_some() {
            return Err(Error::AlreadyRegistered);
        }

        let side = bracket.registered;
        let node_id = Self::node_id(bracket.size, 0, side / 2);
        let mut node = Self::load_node(&env, bracket_id, node_id)?;
        let value = Slot::Filled(participant.clone());
        if side % 2 == 0 {
            node.slot1 = value;
        } else {
            node.slot2 = value;
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
        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
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

    /// Record the winner of a match and advance them in the bracket.
    pub fn submit_result(
        env: Env,
        bracket_id: u64,
        node_id: u64,
        winner: Address,
        caller: Address,
    ) -> Result<(), Error> {
        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        if caller != bracket.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let mut node = Self::load_node(&env, bracket_id, node_id)?;
        match Self::node_state(&node, &bracket)? {
            // The node is not decided yet, it is not a bye either.
            NodeState::AwaitingParticipants => return Err(Error::SlotVacant),
            // A bye or a void node is never played.
            NodeState::ByeAdvance(_) | NodeState::Void => return Err(Error::NotPlayable),
            NodeState::Resolved(_) => return Err(Error::AlreadyResolved),
            NodeState::Ready => {}
        }

        let is_participant = matches!(&node.slot1, Slot::Filled(a) if *a == winner)
            || matches!(&node.slot2, Slot::Filled(a) if *a == winner);
        if !is_participant {
            return Err(Error::InvalidWinner);
        }

        node.winner = Some(winner.clone());
        Self::save_node(&env, &node);

        // The winner advances into the next round, a bye on the way may hand
        // them the round as well.
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
    /// is submitted. This entry point only makes the rule explicit, it is
    /// idempotent and it rejects a node that is not a bye.
    pub fn advance_bye(env: Env, bracket_id: u64, node_id: u64) -> Result<(), Error> {
        let mut bracket = Self::load_bracket(&env, bracket_id)?;
        let node = Self::load_node(&env, bracket_id, node_id)?;

        match Self::node_state(&node, &bracket)? {
            NodeState::ByeAdvance(_) => {}
            // Not decided yet: an unfilled node is not a bye.
            NodeState::AwaitingParticipants => return Err(Error::SlotVacant),
            NodeState::Void | NodeState::Ready | NodeState::Resolved(_) => {
                return Err(Error::NotABye)
            }
        }

        Self::settle_from(&env, &mut bracket, node_id)?;

        env.events().publish(
            (Symbol::new(&env, "bracket"), symbol_short!("advance")),
            (bracket_id, node_id),
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

    /// Derive the state of a node from its sides.
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
                if node.winner.is_some() {
                    return Err(Error::MalformedNode);
                }
                Ok(NodeState::AwaitingParticipants)
            }
            (Slot::Filled(p1), Slot::Filled(p2)) => {
                if p1 == p2 {
                    // Nobody plays against themselves.
                    return Err(Error::MalformedNode);
                }
                match &node.winner {
                    Some(w) if w == p1 || w == p2 => Ok(NodeState::Resolved(w.clone())),
                    Some(_) => Err(Error::MalformedNode),
                    None => Ok(NodeState::Ready),
                }
            }
            // One side is a bye: the participant advances without playing.
            (Slot::Filled(p), Slot::Bye) | (Slot::Bye, Slot::Filled(p)) => {
                if node.winner.is_some() {
                    // A bye node is never played, so it cannot carry a winner.
                    return Err(Error::MalformedNode);
                }
                Ok(NodeState::ByeAdvance(p.clone()))
            }
            // Both sides are byes: nobody advances out of this node.
            (Slot::Bye, Slot::Bye) => {
                if node.winner.is_some() {
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
    /// participants or is ready to be played.
    fn settle_from(env: &Env, bracket: &mut Bracket, node_id: u64) -> Result<(), Error> {
        let size = bracket.size;
        let rounds = bracket.rounds;
        let mut current = node_id;

        loop {
            let node = Self::load_node(env, bracket.id, current)?;
            let state = Self::node_state(&node, bracket)?;

            let contribution = match state {
                NodeState::AwaitingParticipants | NodeState::Ready => return Ok(()),
                NodeState::ByeAdvance(participant) => Slot::Filled(participant),
                NodeState::Void => Slot::Bye,
                NodeState::Resolved(winner) => Slot::Filled(winner),
            };

            let (parent_id, side) = match Self::parent_of(size, rounds, &node) {
                Some(parent) => parent,
                // Last round: the node decides the champion.
                None => {
                    if let Slot::Filled(champion) = contribution {
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
    fn write_parent_slot(
        env: &Env,
        bracket_id: u64,
        parent_id: u64,
        side: u32,
        value: Slot,
    ) -> Result<(), Error> {
        let mut parent = Self::load_node(env, bracket_id, parent_id)?;
        let current = if side == 0 {
            parent.slot1.clone()
        } else {
            parent.slot2.clone()
        };

        match (&current, &value) {
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
