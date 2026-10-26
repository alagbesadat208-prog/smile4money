use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// The bracket or the node does not exist.
    NotFound = 1,
    /// initialize was called more than once.
    AlreadyInitialized = 2,
    /// The caller is not the bracket admin or authorized reviewer.
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
    /// The node already carries a reported or finalized result.
    AlreadyResolved = 14,
    /// The bracket counter or deadline calculation would overflow.
    Overflow = 15,
    /// Emergency mode is active: tournament progression is paused.
    ContractPaused = 16,
    /// The bracket has been cancelled: only participant exits are allowed.
    BracketCancelled = 17,
    /// The caller does not occupy an active slot in this bracket.
    NotRegistered = 18,
    /// The bracket has already been completed.
    AlreadyCompleted = 19,
    /// The entry fee amount is invalid.
    InvalidAmount = 20,
    /// The node does not currently have a result under review.
    NotUnderReview = 21,
    /// The review window has not expired yet; the result cannot be finalized.
    ReviewWindowOpen = 22,
    /// The review window has already expired; the result can no longer be amended.
    ReviewWindowExpired = 23,
    /// The configured review window duration is invalid (must be > 0).
    InvalidReviewWindow = 24,
    /// A participant would occupy both sides of a match or appear more than once.
    DuplicateParticipant = 25,
}
