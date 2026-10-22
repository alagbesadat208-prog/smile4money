use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

fn setup() -> (Env, Address, BracketContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(BracketContract, ());
    let client = BracketContractClient::new(&env, &contract_id);
    client.initialize(&admin);

    (env, contract_id, client, admin)
}

#[test]
fn test_vacant_slots_are_not_byes_before_lock() {
    let (env, _contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);

    let bracket_id = client.create_bracket(&4);
    client.register(&bracket_id, &p1);

    // Node 0 has one participant and one vacant slot — NOT a bye.
    let node0 = client.get_node(&bracket_id, &0);
    assert_eq!(node0.slot1, Slot::Filled(p1.clone()));
    assert_eq!(node0.slot2, Slot::Vacant);
    assert_eq!(
        client.get_node_state(&bracket_id, &0),
        NodeState::AwaitingParticipants
    );

    // Node 1 has two vacant slots — NOT void or bye.
    let node1 = client.get_node(&bracket_id, &1);
    assert_eq!(node1.slot1, Slot::Vacant);
    assert_eq!(node1.slot2, Slot::Vacant);
    assert_eq!(
        client.get_node_state(&bracket_id, &1),
        NodeState::AwaitingParticipants
    );

    // Cannot advance an unfilled node as a bye or submit a result on it.
    assert_eq!(
        client.try_advance_bye(&bracket_id, &0),
        Err(Ok(Error::SlotVacant))
    );
    assert_eq!(
        client.try_submit_result(&bracket_id, &0, &p1, &admin),
        Err(Ok(Error::SlotVacant))
    );
}

#[test]
fn test_lock_converts_vacant_to_explicit_bye_and_advances() {
    let (env, _contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    // 4-slot bracket with 3 participants -> 1 explicit bye in round 0 node 1.
    let bracket_id = client.create_bracket(&4);
    client.register(&bracket_id, &p1);
    client.register(&bracket_id, &p2);
    client.register(&bracket_id, &p3);

    client.lock_registration(&bracket_id, &admin);

    // Node 0: p1 vs p2 -> Ready
    assert_eq!(client.get_node_state(&bracket_id, &0), NodeState::Ready);

    // Node 1: p3 vs explicit Bye -> ByeAdvance(p3)
    let node1 = client.get_node(&bracket_id, &1);
    assert_eq!(node1.slot1, Slot::Filled(p3.clone()));
    assert_eq!(node1.slot2, Slot::Bye);
    assert_eq!(
        client.get_node_state(&bracket_id, &1),
        NodeState::ByeAdvance(p3.clone())
    );

    // Final node (node 2) already received p3 in slot2 from the bye advance,
    // while slot1 is still Vacant awaiting node 0.
    let final_node = client.get_node(&bracket_id, &2);
    assert_eq!(final_node.slot1, Slot::Vacant);
    assert_eq!(final_node.slot2, Slot::Filled(p3.clone()));
    assert_eq!(
        client.get_node_state(&bracket_id, &2),
        NodeState::AwaitingParticipants
    );

    // A bye node cannot be played as a normal match.
    assert_eq!(
        client.try_submit_result(&bracket_id, &1, &p3, &admin),
        Err(Ok(Error::NotPlayable))
    );

    // Explicit advance_bye is idempotent on a bye node and rejected on Ready node.
    client.advance_bye(&bracket_id, &1);
    assert_eq!(
        client.try_advance_bye(&bracket_id, &0),
        Err(Ok(Error::NotABye))
    );

    // Resolve node 0 and final.
    client.submit_result(&bracket_id, &0, &p1, &admin);
    assert_eq!(client.get_node_state(&bracket_id, &2), NodeState::Ready);
    client.submit_result(&bracket_id, &2, &p3, &admin);
    assert_eq!(client.get_champion(&bracket_id), p3);
}

#[test]
fn test_double_bye_void_node_propagates_bye_to_next_round() {
    let (env, _contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);

    // 4-slot bracket with only 2 participants in node 0; node 1 gets two byes (Void).
    let bracket_id = client.create_bracket(&4);
    client.register(&bracket_id, &p1);
    client.register(&bracket_id, &p2);
    client.lock_registration(&bracket_id, &admin);

    assert_eq!(client.get_node_state(&bracket_id, &1), NodeState::Void);

    // Final node slot2 is now an explicit Bye.
    let final_node = client.get_node(&bracket_id, &2);
    assert_eq!(final_node.slot1, Slot::Vacant);
    assert_eq!(final_node.slot2, Slot::Bye);

    // When p1 wins node 0, p1 advances into final slot1 and automatically wins via bye!
    client.submit_result(&bracket_id, &0, &p1, &admin);
    assert_eq!(
        client.get_node_state(&bracket_id, &2),
        NodeState::ByeAdvance(p1.clone())
    );
    assert_eq!(client.get_champion(&bracket_id), p1);
}

#[test]
fn test_malformed_nodes_detected_and_rejected() {
    let (env, contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let outsider = Address::generate(&env);

    let bracket_id = client.create_bracket(&4);
    client.register(&bracket_id, &p1);
    client.register(&bracket_id, &p2);
    client.lock_registration(&bracket_id, &admin);

    // 1. Corrupt a locked round-0 node to have a Vacant slot -> MalformedNode.
    env.as_contract(&contract_id, || {
        let mut node = BracketContract::load_node(&env, bracket_id, 1).unwrap();
        node.slot1 = Slot::Vacant;
        BracketContract::save_node(&env, &node);
    });
    assert_eq!(
        client.try_get_node_state(&bracket_id, &1),
        Err(Ok(Error::MalformedNode))
    );

    // 2. Corrupt a Bye node to also carry a winner -> MalformedNode.
    env.as_contract(&contract_id, || {
        let mut node = BracketContract::load_node(&env, bracket_id, 1).unwrap();
        node.slot1 = Slot::Filled(p1.clone());
        node.slot2 = Slot::Bye;
        node.winner = Some(p1.clone());
        BracketContract::save_node(&env, &node);
    });
    assert_eq!(
        client.try_get_node_state(&bracket_id, &1),
        Err(Ok(Error::MalformedNode))
    );
    assert_eq!(
        client.try_advance_bye(&bracket_id, &1),
        Err(Ok(Error::MalformedNode))
    );

    // 3. Corrupt a node so a participant plays against themselves -> MalformedNode.
    env.as_contract(&contract_id, || {
        let mut node = BracketContract::load_node(&env, bracket_id, 0).unwrap();
        node.slot1 = Slot::Filled(p1.clone());
        node.slot2 = Slot::Filled(p1.clone());
        BracketContract::save_node(&env, &node);
    });
    assert_eq!(
        client.try_get_node_state(&bracket_id, &0),
        Err(Ok(Error::MalformedNode))
    );

    // 4. Corrupt a node with a winner that is neither slot -> MalformedNode.
    env.as_contract(&contract_id, || {
        let mut node = BracketContract::load_node(&env, bracket_id, 0).unwrap();
        node.slot1 = Slot::Filled(p1.clone());
        node.slot2 = Slot::Filled(p2.clone());
        node.winner = Some(outsider);
        BracketContract::save_node(&env, &node);
    });
    assert_eq!(
        client.try_get_node_state(&bracket_id, &0),
        Err(Ok(Error::MalformedNode))
    );
}

#[test]
fn test_emergency_pause_authorization_and_blocked_progression() {
    let (env, _contract_id, client, admin) = setup();
    let stranger = Address::generate(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    // Non-admin cannot pause or unpause.
    assert_eq!(client.try_pause(&stranger), Err(Ok(Error::Unauthorized)));
    assert_eq!(client.try_unpause(&stranger), Err(Ok(Error::Unauthorized)));

    let open_bracket = client.create_bracket(&4);
    client.register(&open_bracket, &p1);

    let locked_bracket = client.create_bracket(&4);
    client.register(&locked_bracket, &p1);
    client.register(&locked_bracket, &p2);
    client.register(&locked_bracket, &p3);
    client.lock_registration(&locked_bracket, &admin);

    // Activate emergency mode.
    assert!(!client.is_paused());
    client.pause(&admin);
    assert!(client.is_paused());

    // Every progression entrypoint is blocked while paused.
    assert_eq!(
        client.try_create_bracket(&4),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_register(&open_bracket, &p2),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_lock_registration(&open_bracket, &admin),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_submit_result(&locked_bracket, &0, &p1, &admin),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_advance_bye(&locked_bracket, &1),
        Err(Ok(Error::ContractPaused))
    );

    // Read queries remain available while paused.
    assert_eq!(client.get_bracket(&locked_bracket).registered, 3);
    assert_eq!(client.get_node_state(&locked_bracket, &0), NodeState::Ready);
}

#[test]
fn test_emergency_mode_preserves_participant_exits_and_refunds() {
    let (env, _contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_contract.address();
    let asset_client = StellarAssetClient::new(&env, &token_addr);
    let token_client = TokenClient::new(&env, &token_addr);

    asset_client.mint(&p1, &1000);
    asset_client.mint(&p2, &1000);
    asset_client.mint(&p3, &1000);

    let bracket_id = client.create_paid_bracket(&4, &token_addr, &250);
    client.register(&bracket_id, &p1);
    client.register(&bracket_id, &p2);
    client.register(&bracket_id, &p3);
    assert_eq!(token_client.balance(&p1), 750);
    assert_eq!(token_client.balance(&p2), 750);
    assert_eq!(token_client.balance(&p3), 750);

    // Lock the bracket. During normal play (not paused, not cancelled), a locked
    // bracket rejects arbitrary withdrawal.
    client.lock_registration(&bracket_id, &admin);
    assert_eq!(
        client.try_withdraw(&bracket_id, &p1),
        Err(Ok(Error::RegistrationClosed))
    );

    // Operator triggers emergency pause due to an incident.
    client.pause(&admin);

    // Participant p1 can immediately exit and recover their 250 entry fee while paused,
    // even before the operator explicitly cancels the bracket.
    client.withdraw(&bracket_id, &p1);
    assert_eq!(token_client.balance(&p1), 1000);
    assert!(client.get_bracket(&bracket_id).cancelled);

    // Double withdrawal by p1 is rejected.
    assert_eq!(
        client.try_withdraw(&bracket_id, &p1),
        Err(Ok(Error::NotRegistered))
    );

    // Participant p2 also exits while paused.
    client.withdraw(&bracket_id, &p2);
    assert_eq!(token_client.balance(&p2), 1000);

    // Even after emergency mode is lifted, the affected bracket remains cancelled so
    // remaining participant p3 can still withdraw and match progression stays blocked.
    client.unpause(&admin);
    assert_eq!(
        client.try_submit_result(&bracket_id, &0, &p2, &admin),
        Err(Ok(Error::BracketCancelled))
    );
    client.withdraw(&bracket_id, &p3);
    assert_eq!(token_client.balance(&p3), 1000);
    assert_eq!(client.get_bracket(&bracket_id).registered, 0);
}

#[test]
fn test_cancel_bracket_while_paused_allows_exits() {
    let (env, _contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let stranger = Address::generate(&env);

    let bracket_id = client.create_bracket(&4);
    client.register(&bracket_id, &p1);
    client.register(&bracket_id, &p2);
    client.lock_registration(&bracket_id, &admin);

    client.pause(&admin);

    // Non-admin cannot cancel.
    assert_eq!(
        client.try_cancel_bracket(&bracket_id, &stranger),
        Err(Ok(Error::Unauthorized))
    );

    // Admin can cancel while paused.
    client.cancel_bracket(&bracket_id, &admin);
    assert!(client.get_bracket(&bracket_id).cancelled);

    // Second cancel is rejected.
    assert_eq!(
        client.try_cancel_bracket(&bracket_id, &admin),
        Err(Ok(Error::BracketCancelled))
    );

    // Both participants can exit while paused or after unpausing.
    client.withdraw(&bracket_id, &p1);
    client.unpause(&admin);
    client.withdraw(&bracket_id, &p2);
    assert_eq!(client.get_bracket(&bracket_id).registered, 0);
}
