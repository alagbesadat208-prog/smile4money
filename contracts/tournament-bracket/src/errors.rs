use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// The bracket or the node does not exist.
    NotFound = 1,
    /// initialize was called more than once.
    AlreadyInitialized = 2,
    /// The caller is not the bracket admin.
    Unauthorized = 3,
    /// The bracket size is not a power of two inside the allowed range.
    InvalidSize = 4,
    /// Every side of the bracket is already taken.
    BracketFull = 5,
    /// Registration is closed, the bracket has been sealed.
    RegistrationClosed = 6,
    /// The bracket was already sealed.
    AlreadyLocked = 7,
    /// The participant already occupies a side of this bracket.
    AlreadyRegistered = 8,
    /// The node still has an unfilled side: it is neither playable nor a bye.
    SlotVacant = 9,
    /// The stored node is inconsistent, the bracket state was corrupted.
    MalformedNode = 10,
    /// The node is not a bye node.
    NotABye = 11,
    /// The node cannot be played, it is a bye or a void node.
    NotPlayable = 12,
    /// The winner is not a participant of the node.
    InvalidWinner = 13,
    /// The node already carries a result.
    AlreadyResolved = 14,
    /// The bracket counter would overflow.
    Overflow = 15,
}
