extern crate std;

use super::*;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, String, Vec,
};

/// Entry fee used throughout: large enough to be visible in balance assertions.
const FEE: i128 = 100;

/// Balances before any fees are paid, so expected deltas are easy to read.
const STARTING_BALANCE: i128 = 10_000;

/// A deployed bracket plus the addresses and token needed to drive it.
struct Fixture<'a> {
    env: Env,
    client: TournamentBracketClient<'a>,
    admin: Address,
    oracle: Address,
    token: Address,
    /// `players[i]` is seed `i`, i.e. the strongest seed is index 0.
    players: Vec<Address>,
    contract: Address,
}

impl<'a> Fixture<'a> {
    fn with_field(player_count: usize) -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token = token_id.address();

        let contract = env.register(TournamentBracket, ());
        let client = TournamentBracketClient::new(&env, &contract);
        client.initialize(&admin, &oracle, &token);

        // The reserve buffer is funded by the admin so the contract always keeps
        // enough back to satisfy the minimum-account-balance rule on payout.
        asset(&env, &token).mint(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);

        // `players[i]` is seed `i` (index 0 being the strongest seed). Each entrant
        // must approve this contract before it can pull their entry fee — the
        // SEP-41 transfer checks the spender's allowance.
        let expiration = env.ledger().sequence() + 1_000_000;
        let token_client = TokenClient::new(&env, &token);
        let mut players: Vec<Address> = Vec::new(&env);
        for _ in 0..player_count {
            let p = Address::generate(&env);
            asset(&env, &token).mint(&p, &STARTING_BALANCE);
            token_client.approve(&p, &contract, &STARTING_BALANCE, &expiration);
            players.push_back(p);
        }

        Fixture {
            env,
            client,
            admin,
            oracle,
            token,
            players,
            contract,
        }
    }

    /// A 4-player field: seeds 0..3, two semifinals and a final.
    fn four_players() -> Self {
        Self::with_field(4)
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn seed(&self, i: u32) -> Address {
        self.players.get(i).unwrap()
    }

    /// Create a tournament and have every entrant pay their fee.
    fn create_and_fund_all(&self) -> u64 {
        let id = self.client.create_tournament(&FEE, &self.players);
        for i in 0..self.players.len() {
            self.client.deposit(&id, &self.seed(i));
        }
        id
    }
}

fn asset<'a>(env: &'a Env, token: &'a Address) -> StellarAssetClient<'a> {
    StellarAssetClient::new(env, token)
}

fn game_id(env: &Env, n: u32) -> String {
    String::from_str(env, &std::format!("game-{}", n))
}

/// Minimal token contract that can fail an outbound transfer to a selected
/// recipient, exercising rollback after previous transfers have succeeded.
#[contract]
pub struct FaultInjectingToken;

#[contracttype]
#[derive(Clone)]
enum FaultTokenKey {
    Balance(Address),
    FailingRecipient,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum FaultTokenError {
    InjectedTransferFailure = 1,
    InsufficientBalance = 2,
}

#[contractimpl]
impl FaultInjectingToken {
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn balance(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&FaultTokenKey::Balance(account))
            .unwrap_or(0)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), FaultTokenError> {
        let failing: Option<Address> = env
            .storage()
            .instance()
            .get(&FaultTokenKey::FailingRecipient)
            .unwrap_or(None);
        if failing.as_ref() == Some(&to) {
            return Err(FaultTokenError::InjectedTransferFailure);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        let to_balance = Self::balance(env.clone(), to.clone());
        let new_from = from_balance
            .checked_sub(amount)
            .ok_or(FaultTokenError::InsufficientBalance)?;
        let new_to = to_balance
            .checked_add(amount)
            .ok_or(FaultTokenError::InsufficientBalance)?;
        env.storage()
            .persistent()
            .set(&FaultTokenKey::Balance(from), &new_from);
        env.storage()
            .persistent()
            .set(&FaultTokenKey::Balance(to), &new_to);
        Ok(())
    }

    pub fn set_balance(env: Env, account: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&FaultTokenKey::Balance(account), &amount);
    }

    pub fn set_failing_recipient(env: Env, recipient: Option<Address>) {
        env.storage()
            .instance()
            .set(&FaultTokenKey::FailingRecipient, &recipient);
    }
}

struct AtomicityFixture<'a> {
    env: Env,
    client: TournamentBracketClient<'a>,
    token_client: FaultInjectingTokenClient<'a>,
    players: Vec<Address>,
    contract: Address,
}

impl<'a> AtomicityFixture<'a> {
    fn new(player_count: usize) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let token = env.register(FaultInjectingToken, ());
        let token_client = FaultInjectingTokenClient::new(&env, &token);
        let contract = env.register(TournamentBracket, ());
        let client = TournamentBracketClient::new(&env, &contract);
        client.initialize(&admin, &oracle, &token);

        token_client.set_balance(&contract, &ESCROW_RESERVE_BUFFER_STROOPS);
        let mut players = Vec::new(&env);
        for _ in 0..player_count {
            let player = Address::generate(&env);
            token_client.set_balance(&player, &STARTING_BALANCE);
            players.push_back(player);
        }

        Self {
            env,
            client,
            token_client,
            players,
            contract,
        }
    }

    fn player(&self, index: u32) -> Address {
        self.players.get(index).unwrap()
    }

    fn balance(&self, account: &Address) -> i128 {
        self.token_client.balance(account)
    }

    fn create_and_fund_all(&self) -> u64 {
        let id = self.client.create_tournament(&FEE, &self.players);
        for i in 0..self.players.len() {
            self.client.deposit(&id, &self.player(i));
        }
        id
    }
}

// ----------------------- full bracket progression -----------------------

/// The acceptance criterion: a 4-player tournament runs start to finish.
#[test]
fn four_player_tournament_progresses_to_a_paid_champion() {
    let f = Fixture::four_players();
    let s0 = f.seed(0);
    let s1 = f.seed(1);
    let s2 = f.seed(2);
    let s3 = f.seed(3);

    // Bracket is built before anyone pays.
    let id = f.client.create_tournament(&FEE, &f.players);
    let t = f.client.get_tournament(&id);
    assert_eq!(t.player_count, 4);
    assert_eq!(t.rounds, 2);
    assert_eq!(t.state, TournamentState::Registration);
    assert_eq!(t.funded_count, 0);
    assert_eq!(f.client.get_prize_pool(&id), FEE * 4);

    // Snake seeding: [s0 s3] [s1 s2].
    let semi_a = f.client.get_node(&id, &0, &0);
    let semi_b = f.client.get_node(&id, &0, &1);
    assert_eq!(semi_a.player1, Some(s0.clone()));
    assert_eq!(semi_a.player2, Some(s3.clone()));
    assert_eq!(semi_b.player1, Some(s1.clone()));
    assert_eq!(semi_b.player2, Some(s2.clone()));

    // The final exists but has no entrants yet.
    let final_node = f.client.get_node(&id, &1, &0);
    assert_eq!(final_node.player1, None);
    assert_eq!(final_node.player2, None);
    assert_eq!(final_node.status, NodeStatus::AwaitingFunding);

    // -- Round 0: all four pay. -----------------------------------------
    f.client.deposit(&id, &s0);
    // One payer is not enough to arm a semifinal.
    assert_eq!(
        f.client.get_node(&id, &0, &0).status,
        NodeStatus::AwaitingFunding
    );

    f.client.deposit(&id, &s3);
    assert_eq!(
        f.client.get_node(&id, &0, &0).status,
        NodeStatus::AwaitingResult
    );
    f.client.deposit(&id, &s1);
    f.client.deposit(&id, &s2);
    assert_eq!(
        f.client.get_node(&id, &0, &1).status,
        NodeStatus::AwaitingResult
    );

    // Field is full: the tournament is live and the pot is 4 x FEE.
    assert_eq!(f.client.get_funded_count(&id), 4);
    assert_eq!(
        f.client.get_tournament(&id).state,
        TournamentState::InProgress
    );
    assert_eq!(
        f.balance(&f.contract),
        ESCROW_RESERVE_BUFFER_STROOPS + FEE * 4
    );

    // -- Round 0 results. s0 and s1 win their semifinals. ---------------
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &s0);
    assert_eq!(f.client.get_node(&id, &0, &0).winner, Some(s0.clone()));

    // The winner has landed in the final, but the other semifinal is unplayed
    // so the final cannot start yet.
    assert_eq!(f.client.get_node(&id, &1, &0).player1, Some(s0.clone()));
    assert_eq!(f.client.get_node(&id, &1, &0).player2, None);
    assert_eq!(
        f.client.get_node(&id, &1, &0).status,
        NodeStatus::AwaitingFunding
    );

    f.client
        .submit_match_result(&id, &0, &1, &game_id(&f.env, 2), &s1);

    // Both finalists are in place: the final is armed.
    let final_node = f.client.get_node(&id, &1, &0);
    assert_eq!(final_node.player1, Some(s0.clone()));
    assert_eq!(final_node.player2, Some(s1.clone()));
    assert_eq!(final_node.status, NodeStatus::AwaitingResult);

    // -- Nothing has been paid out yet. ---------------------------------
    // s0 already won a match but has still only lost their own fee.
    assert_eq!(f.balance(&s0), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&s1), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&s2), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&s3), STARTING_BALANCE - FEE);

    // -- The final. s0 wins the tournament. ------------------------------
    f.client
        .submit_match_result(&id, &1, &0, &game_id(&f.env, 3), &s0);

    // Champion takes the whole 4 x FEE pot.
    assert_eq!(f.balance(&s0), STARTING_BALANCE - FEE + FEE * 4);
    assert_eq!(f.balance(&s1), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&s2), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&s3), STARTING_BALANCE - FEE);

    // The contract keeps only the reserve.
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);

    assert_eq!(f.client.get_champion(&id), s0);
    let t = f.client.get_tournament(&id);
    assert_eq!(t.state, TournamentState::Completed);
    assert_eq!(t.champion, Some(s0));
    assert!(t.completed_ledger.is_some());
}

/// A 2-player tournament is a bracket with a single match, and the loser of that
/// match is the final loser.
#[test]
fn two_player_tournament_is_a_single_match() {
    let f = Fixture::with_field(2);
    let a = f.seed(0);
    let b = f.seed(1);
    let id = f.create_and_fund_all();

    assert_eq!(f.client.get_tournament(&id).rounds, 1);
    let node = f.client.get_node(&id, &0, &0);
    assert_eq!(node.player1, Some(a.clone()));
    assert_eq!(node.player2, Some(b.clone()));

    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &b);

    assert_eq!(f.client.get_champion(&id), b);
    assert_eq!(f.balance(&b), STARTING_BALANCE - FEE + FEE * 2);
    assert_eq!(f.balance(&a), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
}

/// The stronger seed is kept away from the weaker seeds for as long as possible:
/// seeds 0 and 1 of a 4-player field can only meet in the final.
#[test]
fn top_two_seeds_can_only_meet_in_the_final() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();

    // If seeds 0 and 1 both win their semifinals they are the two finalists.
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    f.client
        .submit_match_result(&id, &0, &1, &game_id(&f.env, 2), &f.seed(1));

    let final_node = f.client.get_node(&id, &1, &0);
    assert_eq!(final_node.player1, Some(f.seed(0)));
    assert_eq!(final_node.player2, Some(f.seed(1)));

    // Conversely, the bottom two seeds meet in the first round, never the final.
    let semi = f.client.get_node(&id, &0, &1);
    assert!(semi.player1.as_ref().unwrap() == &f.seed(1));
    assert!(semi.player2.as_ref().unwrap() == &f.seed(2));
}

/// A full 8-player field produces 7 nodes over 3 rounds, and the seeding spreads
/// each seed so it only meets seeds well away from it.
#[test]
fn eight_player_field_has_seven_nodes_and_three_rounds() {
    let f = Fixture::with_field(8);
    let id = f.client.create_tournament(&FEE, &f.players);
    assert_eq!(f.client.get_tournament(&id).rounds, 3);

    // Round 0: 4 nodes, round 1: 2 nodes, round 2: 1 node = 7 total.
    for i in 0..4u32 {
        let node = f.client.get_node(&id, &0, &i);
        assert_eq!(node.round, 0);
        assert_eq!(node.index, i);
    }
    for i in 0..2u32 {
        f.client.get_node(&id, &1, &i);
    }
    f.client.get_node(&id, &2, &0);

    // Round 0 is seeded [s0 s7] [s1 s6] [s2 s5] [s3 s4].
    assert_eq!(f.client.get_node(&id, &0, &0).player1, Some(f.seed(0)));
    assert_eq!(f.client.get_node(&id, &0, &0).player2, Some(f.seed(7)));
    assert_eq!(f.client.get_node(&id, &0, &1).player1, Some(f.seed(1)));
    assert_eq!(f.client.get_node(&id, &0, &1).player2, Some(f.seed(6)));
    assert_eq!(f.client.get_node(&id, &0, &2).player1, Some(f.seed(2)));
    assert_eq!(f.client.get_node(&id, &0, &2).player2, Some(f.seed(5)));
    assert_eq!(f.client.get_node(&id, &0, &3).player1, Some(f.seed(3)));
    assert_eq!(f.client.get_node(&id, &0, &3).player2, Some(f.seed(4)));

    // There is no fourth round, and no fifth node in the first round.
    assert_eq!(
        f.client.try_get_node(&id, &3, &0),
        Err(Ok(Error::NodeNotFound))
    );
    assert_eq!(
        f.client.try_get_node(&id, &0, &4),
        Err(Ok(Error::NodeNotFound))
    );
}

/// A full 64-player field is the documented maximum, and 128 is rejected.
#[test]
fn field_size_bounds_are_enforced() {
    let f = Fixture::with_field(64);
    let id = f.client.create_tournament(&FEE, &f.players);
    assert_eq!(f.client.get_tournament(&id).rounds, 6);
    assert_eq!(f.client.get_prize_pool(&id), FEE * 64);
    // 6 rounds of 32/16/8/4/2/1 nodes, so round 0 stops at index 31 and there is
    // no seventh round.
    assert_eq!(
        f.client.try_get_node(&id, &0, &32),
        Err(Ok(Error::NodeNotFound))
    );
    assert_eq!(
        f.client.try_get_node(&id, &6, &0),
        Err(Ok(Error::NodeNotFound))
    );
    f.client.get_node(&id, &0, &31);

    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract = env.register(TournamentBracket, ());
    let client = TournamentBracketClient::new(&env, &contract);
    client.initialize(&admin, &admin, &token_id.address());

    let mut many: Vec<Address> = Vec::new(&env);
    for _ in 0..128 {
        many.push_back(Address::generate(&env));
    }
    assert_eq!(
        client.try_create_tournament(&FEE, &many),
        Err(Ok(Error::InvalidPlayerCount))
    );
}

#[test]
fn failed_champion_transfer_rolls_back_final_result_and_can_be_retried_once() {
    let f = AtomicityFixture::new(2);
    let winner = f.player(0);
    let id = f.create_and_fund_all();

    f.token_client.set_failing_recipient(&Some(winner.clone()));
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &winner),
        Err(Ok(Error::TransferFailed))
    );

    let tournament = f.client.get_tournament(&id);
    assert_eq!(tournament.state, TournamentState::InProgress);
    assert_eq!(tournament.champion, None);
    assert_eq!(tournament.completed_ledger, None);
    assert_eq!(
        f.client.get_node(&id, &0, &0).status,
        NodeStatus::AwaitingResult
    );
    assert_eq!(f.client.get_node(&id, &0, &0).winner, None);
    assert_eq!(f.balance(&winner), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&f.player(1)), STARTING_BALANCE - FEE);
    assert_eq!(
        f.balance(&f.contract),
        ESCROW_RESERVE_BUFFER_STROOPS + FEE * 2
    );

    f.token_client.set_failing_recipient(&None);
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 2), &winner);
    assert_eq!(f.client.get_champion(&id), winner);
    assert_eq!(f.balance(&winner), STARTING_BALANCE - FEE + FEE * 2);
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 3), &winner),
        Err(Ok(Error::TournamentFinished))
    );
    assert_eq!(f.balance(&winner), STARTING_BALANCE - FEE + FEE * 2);
}

#[test]
fn failed_later_refund_rolls_back_earlier_transfers_and_can_be_retried_once() {
    let f = AtomicityFixture::new(4);
    let first_refund = f.player(0);
    let failing_refund = f.player(3);
    let id = f.client.create_tournament(&FEE, &f.players);
    f.client.deposit(&id, &first_refund);
    f.client.deposit(&id, &failing_refund);

    // The first transfer is allowed; the second transfer aborts the batch.
    f.token_client
        .set_failing_recipient(&Some(failing_refund.clone()));
    assert_eq!(
        f.client.try_cancel_tournament(&id),
        Err(Ok(Error::TransferFailed))
    );

    let tournament = f.client.get_tournament(&id);
    assert_eq!(tournament.state, TournamentState::Registration);
    assert_eq!(tournament.funded_count, 2);
    assert_eq!(tournament.completed_ledger, None);
    assert!(f.client.get_node(&id, &0, &0).funded1);
    assert!(f.client.get_node(&id, &0, &0).funded2);
    assert_eq!(f.balance(&first_refund), STARTING_BALANCE - FEE);
    assert_eq!(f.balance(&failing_refund), STARTING_BALANCE - FEE);
    assert_eq!(
        f.balance(&f.contract),
        ESCROW_RESERVE_BUFFER_STROOPS + FEE * 2
    );

    f.token_client.set_failing_recipient(&None);
    f.client.cancel_tournament(&id);
    assert_eq!(
        f.client.get_tournament(&id).state,
        TournamentState::Cancelled
    );
    assert_eq!(f.client.get_funded_count(&id), 0);
    for index in 0..4 {
        assert_eq!(f.balance(&f.player(index)), STARTING_BALANCE);
    }
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
    assert_eq!(
        f.client.try_cancel_tournament(&id),
        Err(Ok(Error::TournamentInProgress))
    );
    for index in 0..4 {
        assert_eq!(f.balance(&f.player(index)), STARTING_BALANCE);
    }
}

// ------------------------------ rejections ------------------------------

#[test]
fn non_power_of_two_field_is_rejected() {
    let f = Fixture::with_field(3);
    assert_eq!(
        f.client.try_create_tournament(&FEE, &f.players),
        Err(Ok(Error::InvalidPlayerCount))
    );
}

#[test]
fn single_player_field_is_rejected() {
    let f = Fixture::with_field(1);
    assert_eq!(
        f.client.try_create_tournament(&FEE, &f.players),
        Err(Ok(Error::InvalidPlayerCount))
    );
}

#[test]
fn duplicate_entrants_are_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract = env.register(TournamentBracket, ());
    let client = TournamentBracketClient::new(&env, &contract);
    client.initialize(&admin, &admin, &token_id.address());

    let dup = Address::generate(&env);
    let players = vec![&env, dup.clone(), dup.clone(), dup.clone(), dup.clone()];
    assert_eq!(
        client.try_create_tournament(&FEE, &players),
        Err(Ok(Error::DuplicatePlayer))
    );
}

#[test]
fn zero_address_entrant_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract = env.register(TournamentBracket, ());
    let client = TournamentBracketClient::new(&env, &contract);
    client.initialize(&admin, &admin, &token_id.address());

    // The all-zeros Stellar account key: the canonical burn address.
    let zero = Address::from_string(&String::from_str(
        &env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    ));
    let players = vec![
        &env,
        zero,
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    assert_eq!(
        client.try_create_tournament(&FEE, &players),
        Err(Ok(Error::InvalidAddress))
    );
}

#[test]
fn entry_fee_bounds_are_enforced() {
    let f = Fixture::four_players();
    assert_eq!(
        f.client.try_create_tournament(&0i128, &f.players),
        Err(Ok(Error::StakeTooLow))
    );
    // 4 x (MAX_PRIZE_POOL) overshoots the pool cap.
    assert_eq!(
        f.client
            .try_create_tournament(&(MAX_PRIZE_POOL / 2 + 1), &f.players),
        Err(Ok(Error::StakeTooHigh))
    );
}

#[test]
fn non_entrant_cannot_fund() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    let outsider = Address::generate(&f.env);
    assert_eq!(
        f.client.try_deposit(&id, &outsider),
        Err(Ok(Error::PlayerNotRegistered))
    );
}

#[test]
fn entrant_cannot_fund_twice() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    f.client.deposit(&id, &f.seed(0));
    assert_eq!(
        f.client.try_deposit(&id, &f.seed(0)),
        Err(Ok(Error::AlreadyFunded))
    );
    // The rejected second attempt must not have moved any tokens.
    assert_eq!(f.balance(&f.seed(0)), STARTING_BALANCE - FEE);
}

#[test]
fn result_for_a_node_that_is_not_armed_is_rejected() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);

    // Nobody has paid, so no node can accept a result.
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0)),
        Err(Ok(Error::InvalidNodeStatus))
    );

    // Only one of the two has paid: still not armed.
    f.client.deposit(&id, &f.seed(0));
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0)),
        Err(Ok(Error::InvalidNodeStatus))
    );
}

#[test]
fn result_for_an_unknown_node_is_rejected() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &9, &0, &game_id(&f.env, 1), &f.seed(0)),
        Err(Ok(Error::NodeNotFound))
    );
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &7, &game_id(&f.env, 1), &f.seed(0)),
        Err(Ok(Error::NodeNotFound))
    );
}

#[test]
fn a_winner_outside_the_match_is_rejected() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    // Seed 2 is in the other semifinal.
    let stranger = f.seed(2);
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &stranger),
        Err(Ok(Error::WinnerNotInMatch))
    );
    // Nothing was recorded, so the node is still open.
    assert_eq!(
        f.client.get_node(&id, &0, &0).status,
        NodeStatus::AwaitingResult
    );
}

#[test]
fn a_result_cannot_be_resubmitted_for_the_same_node() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 2), &f.seed(3)),
        Err(Ok(Error::InvalidNodeStatus))
    );
}

#[test]
fn malformed_game_id_is_rejected() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    let empty = String::from_str(&f.env, "");
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &empty, &f.seed(0)),
        Err(Ok(Error::InvalidGameId))
    );
    // A space is outside [A-Za-z0-9_-].
    let spaced = String::from_str(&f.env, "game 1");
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &spaced, &f.seed(0)),
        Err(Ok(Error::InvalidGameId))
    );
    // 65 bytes is one over the cap.
    let too_long = String::from_str(&f.env, &"g".repeat(65));
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &too_long, &f.seed(0)),
        Err(Ok(Error::InvalidGameId))
    );
}

#[test]
fn unknown_tournament_is_rejected() {
    let f = Fixture::four_players();
    assert_eq!(
        f.client.try_get_tournament(&7),
        Err(Ok(Error::TournamentNotFound))
    );
    assert_eq!(
        f.client.try_get_prize_pool(&7),
        Err(Ok(Error::TournamentNotFound))
    );
}

#[test]
fn initialize_is_not_repeatable() {
    let f = Fixture::four_players();
    assert_eq!(
        f.client.try_initialize(&f.admin, &f.oracle, &f.token),
        Err(Ok(Error::AlreadyInitialized))
    );
}

// -------------------- cancellation and timeouts --------------------

#[test]
fn admin_cancels_an_unstarted_tournament_and_refunds_everyone() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    f.client.deposit(&id, &f.seed(0));
    f.client.deposit(&id, &f.seed(3));

    f.client.cancel_tournament(&id);

    assert_eq!(
        f.client.get_tournament(&id).state,
        TournamentState::Cancelled
    );
    // Both payers are made whole; the two who never paid are untouched.
    for i in 0..4u32 {
        assert_eq!(f.balance(&f.seed(i)), STARTING_BALANCE, "seed {}", i);
    }
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
    assert_eq!(f.client.get_funded_count(&id), 0);
}

#[test]
fn a_cancelled_tournament_rejects_further_entries() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    f.client.deposit(&id, &f.seed(0));

    f.client.cancel_tournament(&id);

    assert_eq!(f.balance(&f.seed(0)), STARTING_BALANCE);
    assert_eq!(
        f.client.try_deposit(&id, &f.seed(1)),
        Err(Ok(Error::TournamentFinished))
    );
}

#[test]
fn admin_cannot_cancel_a_tournament_in_progress() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    assert_eq!(
        f.client.try_cancel_tournament(&id),
        Err(Ok(Error::TournamentInProgress))
    );
}

#[test]
fn claim_timeout_is_rejected_before_the_window_elapses() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    let caller = f.seed(0);
    assert_eq!(
        f.client.try_claim_timeout(&id, &caller),
        Err(Ok(Error::TimeoutNotReached))
    );

    // One ledger before the deadline is still too early.
    f.env
        .ledger()
        .set_sequence_number(f.client.get_tournament(&id).created_ledger + TIMEOUT_LEDGERS);
    assert_eq!(
        f.client.try_claim_timeout(&id, &caller),
        Err(Ok(Error::TimeoutNotReached))
    );
}

#[test]
fn claim_timeout_refunds_everyone_after_the_window() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();

    // A stranger can trigger it: the backstop must not depend on a participant.
    let stranger = Address::generate(&f.env);
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    });
    f.env.as_contract(&f.token, || {
        f.env
            .storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    });
    f.env
        .ledger()
        .set_sequence_number(f.client.get_tournament(&id).created_ledger + TIMEOUT_LEDGERS + 1);
    f.client.claim_timeout(&id, &stranger);

    assert_eq!(
        f.client.get_tournament(&id).state,
        TournamentState::Cancelled
    );
    for i in 0..4u32 {
        assert_eq!(f.balance(&f.seed(i)), STARTING_BALANCE, "seed {}", i);
    }
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
}

#[test]
fn a_finished_tournament_cannot_be_timed_out() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    f.client
        .submit_match_result(&id, &0, &1, &game_id(&f.env, 2), &f.seed(1));
    f.client
        .submit_match_result(&id, &1, &0, &game_id(&f.env, 3), &f.seed(0));
    let caller = f.seed(3);
    f.env
        .ledger()
        .set_sequence_number(f.client.get_tournament(&id).created_ledger + TIMEOUT_LEDGERS + 1);
    assert_eq!(
        f.client.try_claim_timeout(&id, &caller),
        Err(Ok(Error::TournamentFinished))
    );
}

#[test]
fn a_completed_tournament_rejects_further_entries_and_results() {
    let f = Fixture::four_players();
    let id = f.create_and_fund_all();
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    f.client
        .submit_match_result(&id, &0, &1, &game_id(&f.env, 2), &f.seed(1));
    f.client
        .submit_match_result(&id, &1, &0, &game_id(&f.env, 3), &f.seed(0));

    assert_eq!(
        f.client.try_deposit(&id, &f.seed(0)),
        Err(Ok(Error::TournamentFinished))
    );
    assert_eq!(
        f.client
            .try_submit_match_result(&id, &0, &0, &game_id(&f.env, 4), &f.seed(3)),
        Err(Ok(Error::TournamentFinished))
    );
    assert_eq!(
        f.client.try_cancel_tournament(&id),
        Err(Ok(Error::TournamentInProgress))
    );
}

// --------------------- multiple tournaments ---------------------

#[test]
fn tournaments_are_isolated_from_one_another() {
    let f = Fixture::with_field(4);
    let first = f.create_and_fund_all();
    let second = f.create_and_fund_all();
    assert_ne!(first, second);
    assert_eq!(f.client.tournament_count(), 2);

    // Deciding the second tournament's semifinal must not touch the first.
    f.client
        .submit_match_result(&second, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    assert_eq!(f.client.get_node(&first, &0, &0).winner, None);
    assert_eq!(
        f.client.get_tournament(&first).state,
        TournamentState::InProgress
    );
}

#[test]
fn prize_schedule_default_and_custom() {
    let f = Fixture::with_field(4);
    let id = f.client.create_tournament(&FEE, &f.players);
    assert_eq!(f.client.get_prize_schedule(&id), vec![&f.env, FEE * 4]);
    assert_eq!(f.client.get_tournament(&id).token, f.token);

    let sched = vec![&f.env, 250i128, 100i128];
    let id2 = f
        .client
        .create_tournament_with_prizes(&FEE, &f.players, &sched);
    assert_eq!(f.client.get_prize_schedule(&id2), sched);
}

#[test]
fn prize_schedule_rejects_invalid() {
    let f = Fixture::with_field(4);
    for bad in [
        vec![&f.env, 401i128],
        vec![&f.env],
        vec![&f.env, 100i128, 0i128],
        vec![&f.env, 1i128, 1i128, 1i128, 1i128, 1i128],
    ] {
        assert_eq!(
            f.client
                .try_create_tournament_with_prizes(&FEE, &f.players, &bad),
            Err(Ok(Error::InvalidPrizeSchedule))
        );
    }
}
