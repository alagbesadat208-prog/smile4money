extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    contracttype, vec, Address, Env, String, Vec,
};

mod legacy {
    use super::{Address, TournamentState};
    use soroban_sdk::contracttype;

    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct Tournament {
        pub id: u64,
        pub admin: Address,
        pub token: Address,
        pub entry_fee: i128,
        pub player_count: u32,
        pub rounds: u32,
        pub funded_count: u32,
        pub state: TournamentState,
        pub champion: Option<Address>,
        pub created_ledger: u32,
        pub completed_ledger: Option<u32>,
    }
}

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
        // Keep the test token alive across the timeout ledger jump. Production
        // callers restore archived entries as part of transaction preparation.
        env.ledger()
            .with_mut(|info| info.min_persistent_entry_ttl = MATCH_TTL_LEDGERS);
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        token_id
            .issuer()
            .set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
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

fn asset<'a>(env: &'a Env, token: &Address) -> StellarAssetClient<'a> {
    StellarAssetClient::new(env, token)
}

fn game_id(env: &Env, n: u32) -> String {
    String::from_str(env, &std::format!("game-{}", n))
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
    assert_eq!(t.schema_version, TOURNAMENT_SCHEMA_VERSION);
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

    // Finalization only allocates; a separate call transfers the prize.
    assert_eq!(f.balance(&s0), STARTING_BALANCE - FEE);
    assert_eq!(f.client.get_settlement(&id).remaining, FEE * 4);
    assert_eq!(f.client.claim_prize(&id), FEE * 4);
    assert_eq!(
        f.client.try_claim_prize(&id),
        Err(Ok(Error::AlreadyClaimed))
    );
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

#[test]
fn unsupported_tournament_schema_versions_are_rejected() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    let mut tournament = f.client.get_tournament(&id);

    tournament.schema_version = TOURNAMENT_SCHEMA_VERSION + 1;
    f.env
        .storage()
        .persistent()
        .set(&types::DataKey::Tournament(id), &tournament);

    assert_eq!(
        f.client.try_get_tournament(&id),
        Err(Ok(Error::UnsupportedTournamentVersion))
    );
}

#[test]
fn legacy_tournament_records_are_rejected_explicitly() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    let tournament = f.client.get_tournament(&id);
    let legacy = legacy::Tournament {
        id: tournament.id,
        admin: tournament.admin,
        token: tournament.token,
        entry_fee: tournament.entry_fee,
        player_count: tournament.player_count,
        rounds: tournament.rounds,
        funded_count: tournament.funded_count,
        state: tournament.state,
        champion: tournament.champion,
        created_ledger: tournament.created_ledger,
        completed_ledger: tournament.completed_ledger,
    };
    f.env
        .storage()
        .persistent()
        .set(&types::DataKey::Tournament(id), &legacy);

    assert_eq!(
        f.client.try_get_tournament(&id),
        Err(Ok(Error::UnsupportedTournamentVersion))
    );
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

    f.client.claim_prize(&id);
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
    // 6 rounds of 32/16/8/4/2/1 nodes = 63 reachable nodes.
    let mut total_nodes = 0;
    for (round, count) in [32u32, 16, 8, 4, 2, 1].into_iter().enumerate() {
        total_nodes += count;
        f.client.get_node(&id, &(round as u32), &(count - 1));
    }
    assert_eq!(total_nodes, 63);
    // Round 0 stops at index 31 and there is no seventh round.
    assert_eq!(
        f.client.try_get_node(&id, &0, &32),
        Err(Ok(Error::NodeNotFound))
    );
    assert_eq!(
        f.client.try_get_node(&id, &6, &0),
        Err(Ok(Error::NodeNotFound))
    );
    f.client.get_node(&id, &0, &31);

    let minimum = Fixture::with_field(2);
    let min_id = minimum.client.create_tournament(&FEE, &minimum.players);
    assert_eq!(minimum.client.get_tournament(&min_id).rounds, 1);
    minimum.client.get_node(&min_id, &0, &0);
    assert_eq!(
        minimum.client.try_get_node(&min_id, &1, &0),
        Err(Ok(Error::NodeNotFound))
    );

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
    assert_eq!(
        client.try_get_tournament(&0),
        Err(Ok(Error::TournamentNotFound))
    );
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
    let players = vec![&env, dup.clone(), dup.clone()];
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
fn initialize_requires_admin_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let contract = env.register(TournamentBracket, ());
    let client = TournamentBracketClient::new(&env, &contract);

    assert!(client.try_initialize(&admin, &oracle, &token).is_err());
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
    assert_eq!(f.balance(&f.seed(0)), STARTING_BALANCE - FEE);
    f.client.claim_refund(&id, &0, &f.seed(3));
    f.client.claim_refund(&id, &0, &f.seed(0));
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
    f.client.claim_refund(&id, &0, &f.seed(0));

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
    f.env
        .ledger()
        .set_sequence_number(f.client.get_tournament(&id).created_ledger + TIMEOUT_LEDGERS + 1);
    f.client.claim_timeout(&id, &stranger);
    for node in 0..2u32 {
        f.client.claim_refund(&id, &node, &f.seed(node));
        f.client.claim_refund(&id, &node, &f.seed(3 - node));
    }

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

// --------------------- resumable settlement ---------------------

#[test]
fn refund_claims_validate_entitlement_and_cannot_reset_progress() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    f.client.deposit(&id, &f.seed(0));
    assert_eq!(
        f.client.try_claim_refund(&id, &0, &f.seed(0)),
        Err(Ok(Error::InvalidState))
    );
    assert_eq!(f.client.try_claim_prize(&id), Err(Ok(Error::InvalidState)));
    f.client.cancel_tournament(&id);
    assert_eq!(f.client.get_settlement(&id).total, FEE);
    assert_eq!(
        f.client.try_claim_refund(&id, &0, &f.seed(3)),
        Err(Ok(Error::NothingToClaim))
    );
    assert_eq!(
        f.client.try_claim_refund(&id, &1, &f.seed(0)),
        Err(Ok(Error::PlayerNotRegistered))
    );
    assert_eq!(
        f.client.try_claim_refund(&id, &2, &f.seed(0)),
        Err(Ok(Error::NodeNotFound))
    );
    assert_eq!(
        f.client
            .try_claim_refund(&id, &0, &Address::generate(&f.env)),
        Err(Ok(Error::PlayerNotRegistered))
    );
    assert_eq!(f.client.claim_refund(&id, &0, &f.seed(0)), FEE);
    assert_eq!(
        f.client.try_claim_refund(&id, &0, &f.seed(0)),
        Err(Ok(Error::AlreadyClaimed))
    );
    let settled = f.client.get_settlement(&id);
    assert_eq!(settled.remaining, 0);
    assert_eq!(settled.unclaimed, 0);
    assert!(f.client.try_cancel_tournament(&id).is_err());
    assert!(f.client.try_claim_timeout(&id, &f.seed(0)).is_err());
    assert_eq!(f.client.get_settlement(&id), settled);
}

#[test]
fn failed_refund_transfer_rolls_back_and_can_be_retried() {
    let f = Fixture::four_players();
    let id = f.client.create_tournament(&FEE, &f.players);
    f.client.deposit(&id, &f.seed(0));
    f.client.deposit(&id, &f.seed(3));
    asset(&f.env, &f.token).set_authorized(&f.seed(0), &false);
    // A blocked recipient cannot prevent allocation or another recipient's claim.
    f.client.cancel_tournament(&id);
    let allocated = f.client.get_settlement(&id);
    assert!(f.client.try_claim_refund(&id, &0, &f.seed(0)).is_err());
    assert_eq!(f.client.get_settlement(&id), allocated);
    assert_eq!(f.client.get_funded_count(&id), 2);
    f.client.claim_refund(&id, &0, &f.seed(3));
    asset(&f.env, &f.token).set_authorized(&f.seed(0), &true);
    f.client.claim_refund(&id, &0, &f.seed(0));
    assert_eq!(f.balance(&f.seed(0)), STARTING_BALANCE);
    assert_eq!(f.client.get_settlement(&id).remaining, 0);
    assert_eq!(f.client.get_funded_count(&id), 0);
}

#[test]
fn reserve_failure_preserves_prize_and_legacy_records_cannot_pay_again() {
    let f = Fixture::with_field(2);
    let id = f.create_and_fund_all();
    TokenClient::new(&f.env, &f.token).transfer(
        &f.contract,
        &f.admin,
        &ESCROW_RESERVE_BUFFER_STROOPS,
    );
    f.client
        .submit_match_result(&id, &0, &0, &game_id(&f.env, 1), &f.seed(0));
    let allocated = f.client.get_settlement(&id);
    assert_eq!(
        f.client.try_claim_prize(&id),
        Err(Ok(Error::InsufficientReserve))
    );
    assert_eq!(f.client.get_settlement(&id), allocated);
    asset(&f.env, &f.token).mint(&f.contract, &ESCROW_RESERVE_BUFFER_STROOPS);
    f.env.mock_auths(&[]); // A relayer needs no recipient signature; destination is fixed.
    f.client.claim_prize(&id);
    assert_eq!(f.balance(&f.seed(0)), STARTING_BALANCE + FEE);
    // Pre-upgrade terminal records have no allocation marker and were paid inline.
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .persistent()
            .remove(&DataKey::Settlement(id));
    });
    assert_eq!(
        f.client.try_claim_prize(&id),
        Err(Ok(Error::SettlementNotFound))
    );
}

/// Each measured call starts with the SDK's default CPU/memory limits. Setup
/// is excluded. These native host-cost regressions do not replace WASM/network
/// simulation when choosing production transaction resource declarations.
fn report_budget(env: &Env, operation: &str) {
    std::println!(
        "{}: CPU={} memory={}",
        operation,
        env.cost_estimate().budget().cpu_instruction_cost(),
        env.cost_estimate().budget().memory_bytes_cost()
    );
}

#[test]
fn maximum_field_timeout_and_all_64_claims_fit_per_call_budget() {
    let f = Fixture::with_field(64);
    f.env.cost_estimate().budget().reset_unlimited();
    let id = f.create_and_fund_all();
    f.env
        .ledger()
        .set_sequence_number(f.client.get_tournament(&id).created_ledger + TIMEOUT_LEDGERS + 1);
    let caller = f.seed(0);
    f.env.cost_estimate().budget().reset_default();
    f.client.claim_timeout(&id, &caller);
    report_budget(&f.env, "64-player timeout allocation");
    assert_eq!(f.client.get_settlement(&id).remaining, 64 * FEE);
    f.env.mock_auths(&[]);
    // Reverse slot order exercises bit 63 first and resumes after every payment.
    for slot in (0..64u32).rev() {
        let node = slot / 2;
        let recipient = f.seed(if slot % 2 == 0 { node } else { 63 - node });
        f.env.cost_estimate().budget().reset_default();
        assert_eq!(f.client.claim_refund(&id, &node, &recipient), FEE);
        report_budget(&f.env, "64-player individual refund");
        let settlement = f.client.get_settlement(&id);
        assert_eq!(settlement.remaining, slot as i128 * FEE);
        assert_eq!(settlement.unclaimed, slot);
        assert_eq!(f.balance(&recipient), STARTING_BALANCE);
        assert_eq!(
            f.client.try_claim_refund(&id, &node, &recipient),
            Err(Ok(Error::AlreadyClaimed))
        );
    }
    let settled = f.client.get_settlement(&id);
    assert_eq!(settled.claimed, u64::MAX);
    assert_eq!(settled.total, FEE * 64);
    assert_eq!(f.client.get_funded_count(&id), 0);
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
}

#[test]
fn maximum_field_finalization_and_prize_fit_per_call_budget() {
    let f = Fixture::with_field(64);
    f.env.cost_estimate().budget().reset_unlimited();
    let id = f.create_and_fund_all();
    for round in 0..5u32 {
        for index in 0..(64 >> (round + 1)) {
            let winner = f.client.get_node(&id, &round, &index).player1.unwrap();
            f.client.submit_match_result(
                &id,
                &round,
                &index,
                &game_id(&f.env, round * 32 + index),
                &winner,
            );
        }
    }
    let winner = f.client.get_node(&id, &5, &0).player1.unwrap();
    let game = game_id(&f.env, 999);
    f.env.cost_estimate().budget().reset_default();
    f.client.submit_match_result(&id, &5, &0, &game, &winner);
    report_budget(&f.env, "64-player final allocation");
    assert_eq!(f.balance(&winner), STARTING_BALANCE - FEE);
    f.env.cost_estimate().budget().reset_default();
    assert_eq!(f.client.claim_prize(&id), 64 * FEE);
    report_budget(&f.env, "64-player prize claim");
    assert_eq!(f.balance(&winner), STARTING_BALANCE + 63 * FEE);
    assert_eq!(f.client.get_settlement(&id).remaining, 0);
    assert_eq!(f.balance(&f.contract), ESCROW_RESERVE_BUFFER_STROOPS);
}

#[test]
fn maximum_field_partial_cancel_and_empty_cancel_allocate_only_funded_fees() {
    let f = Fixture::with_field(64);
    f.env.cost_estimate().budget().reset_unlimited();
    let id = f.client.create_tournament(&FEE, &f.players);
    for seed in 0..63 {
        f.client.deposit(&id, &f.seed(seed));
    }
    f.env.cost_estimate().budget().reset_default();
    f.client.cancel_tournament(&id);
    report_budget(&f.env, "64-player partial cancellation");
    assert_eq!(f.client.get_settlement(&id).total, 63 * FEE);
    assert_eq!(f.client.get_settlement(&id).unclaimed, 63);
    assert_eq!(
        f.client.try_claim_refund(&id, &0, &f.seed(63)),
        Err(Ok(Error::NothingToClaim))
    );
    f.client.claim_refund(&id, &31, &f.seed(32));
    assert_eq!(f.client.get_settlement(&id).claimed, 1u64 << 63);
    f.env.cost_estimate().budget().reset_unlimited();
    let empty = f.client.create_tournament(&FEE, &f.players);
    f.client.cancel_tournament(&empty);
    assert_eq!(f.client.get_settlement(&empty).total, 0);
    assert_eq!(f.client.get_settlement(&empty).unclaimed, 0);
}
