use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

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
    let (env, _contract_id, client, _admin) = setup();
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
        client.try_submit_result(&bracket_id, &0, &p1, &_admin),
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
