use soroban_sdk::{contracttype, Address};

/// A single side of a bracket node.
///
/// The three variants are deliberately distinct: a side is never "just empty".
///
/// * [`Slot::Filled`] holds the participant that occupies the side.
/// * [`Slot::Bye`] is an *explicit* bye. The bracket has been seeded, nobody
///   will ever take this side and the participant on the other side advances
///   for free.
/// * [`Slot::Vacant`] means the side is still open. Registration has not
///   finished and the side may still be filled.
///
/// Inferring a bye from a missing participant would conflate a valid
/// tournament state with an incomplete registration — or with corrupted
/// storage — so the two are kept apart everywhere in the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Slot {
    /// The side holds a registered participant.
    Filled(Address),
    /// Explicit bye: nobody occupies this side, the opponent advances.
    Bye,
    /// Still unfilled: registration for this side is open.
    Vacant,
}

/// The state of a bracket node, derived from its sides.
///
/// The state is never stored, it is always recomputed from the sides of the
/// node so that it cannot drift away from the recorded bracket.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeState {
    /// At least one side is still vacant. The node is not playable and it is
    /// not a bye either: it is simply not decided yet.
    AwaitingParticipants,
    /// Both sides hold a participant, the match can be played.
    Ready,
    /// Explicit bye: the carried participant advances without playing.
    ByeAdvance(Address),
    /// Both sides are byes: nobody advances out of this node.
    Void,
    /// The match was played, the winner advances.
    Resolved(Address),
}

/// A node of the bracket — one match slot of one round.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Node {
    pub bracket_id: u64,
    /// Flat id of the node inside its bracket.
    pub node_id: u64,
    /// Round index, `0` is the first round.
    pub round: u32,
    /// Index of the node inside its round.
    pub index: u32,
    /// First side of the node.
    pub slot1: Slot,
    /// Second side of the node.
    pub slot2: Slot,
    /// Winner of the match, recorded when the result is submitted.
    pub winner: Option<Address>,
}

/// A tournament bracket.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bracket {
    pub id: u64,
    /// Address allowed to seal the bracket and to submit results.
    pub admin: Address,
    /// Number of first round sides. Always a power of two.
    pub size: u32,
    /// Number of rounds, `log2(size)`.
    pub rounds: u32,
    /// Number of participants that entered the bracket.
    pub registered: u32,
    /// Registration is closed: every side of the first round that was still
    /// vacant has been sealed as an explicit bye.
    pub locked: bool,
    /// Winner of the bracket, set once the final is decided.
    pub champion: Option<Address>,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Bracket(u64),
    BracketCount,
    /// Keyed by (bracket id, node id).
    Node(u64, u64),
}
