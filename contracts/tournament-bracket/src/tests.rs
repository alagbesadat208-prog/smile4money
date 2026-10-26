use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, Vec,
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

fn advance_ledger(env: &Env, delta: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += delta;
    });
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

    // Report and finalize node 0 and final after their review windows.
    client.submit_result(&bracket_id, &0, &p1, &admin);
    advance_ledger(&env, DEFAULT_REVIEW_WINDOW_LEDGERS);
    client.finalize_result(&bracket_id, &0);
    assert_eq!(client.get_node_state(&bracket_id, &2), NodeState::Ready);

    client.submit_result(&bracket_id, &2, &p3, &admin);
    advance_ledger(&env, DEFAULT_REVIEW_WINDOW_LEDGERS);
    client.finalize_result(&bracket_id, &2);
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

    // When p1 wins node 0 and the review window is finalized, p1 advances into
    // final slot1 and automatically wins via bye!
    client.submit_result(&bracket_id, &0, &p1, &admin);
    advance_ledger(&env, DEFAULT_REVIEW_WINDOW_LEDGERS);
    client.finalize_result(&bracket_id, &0);
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
fn test_review_window_blocks_advancement_and_allows_authorized_amendment() {
    let (env, _contract_id, client, admin) = setup();
    let reviewer = Address::generate(&env);
    let stranger = Address::generate(&env);
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);
    let p4 = Address::generate(&env);

    let bracket_id = client.create_bracket(&4);

    // Configure a custom 50-ledger review window and dedicated reviewer.
    assert_eq!(
        client.try_set_review_config(&bracket_id, &reviewer, &0, &admin),
        Err(Ok(Error::InvalidReviewWindow))
    );
    assert_eq!(
        client.try_set_review_config(&bracket_id, &reviewer, &50, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    client.set_review_config(&bracket_id, &reviewer, &50, &admin);

    client.register(&bracket_id, &p1);
    client.register(&bracket_id, &p2);
    client.register(&bracket_id, &p3);
    client.register(&bracket_id, &p4);
    client.lock_registration(&bracket_id, &admin);

    let start_ledger = env.ledger().sequence();
    let expected_deadline = start_ledger + 50;

    // Report p1 as provisional winner of node 0.
    client.submit_result(&bracket_id, &0, &p1, &admin);
    assert_eq!(
        client.get_node_state(&bracket_id, &0),
        NodeState::UnderReview(p1.clone(), expected_deadline)
    );

    // Advancement is blocked while under review: parent (final node 2) slot1 is still Vacant.
    let final_node = client.get_node(&bracket_id, &2);
    assert_eq!(final_node.slot1, Slot::Vacant);
    assert_eq!(
        client.get_node_state(&bracket_id, &2),
        NodeState::AwaitingParticipants
    );

    // Finalizing before the deadline is rejected.
    advance_ledger(&env, 25);
    assert_eq!(
        client.try_finalize_result(&bracket_id, &0),
        Err(Ok(Error::ReviewWindowOpen))
    );

    // Non-reviewer (including admin if reviewer was rotated) cannot amend the result.
    assert_eq!(
        client.try_amend_result(&bracket_id, &0, &p2, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_amend_result(&bracket_id, &0, &p2, &admin),
        Err(Ok(Error::Unauthorized))
    );

    // Reviewer cannot amend to a non-participant of node 0.
    assert_eq!(
        client.try_amend_result(&bracket_id, &0, &p3, &reviewer),
        Err(Ok(Error::InvalidWinner))
    );

    // Authorized reviewer amends the contested result from p1 to p2 within the window.
    client.amend_result(&bracket_id, &0, &p2, &reviewer);
    assert_eq!(
        client.get_node_state(&bracket_id, &0),
        NodeState::UnderReview(p2.clone(), expected_deadline)
    );
    assert_eq!(client.get_node(&bracket_id, &2).slot1, Slot::Vacant);

    // Advance ledger to reach the review deadline.
    advance_ledger(&env, 25);

    // Amending after the deadline has expired is rejected.
    assert_eq!(
        client.try_amend_result(&bracket_id, &0, &p1, &reviewer),
        Err(Ok(Error::ReviewWindowExpired))
    );

    // Finalize the result: node 0 becomes Resolved(p2) and p2 advances to final node 2 slot1.
    client.finalize_result(&bracket_id, &0);
    assert_eq!(
        client.get_node_state(&bracket_id, &0),
        NodeState::Resolved(p2.clone())
    );
    assert_eq!(
        client.get_node(&bracket_id, &2).slot1,
        Slot::Filled(p2.clone())
    );

    // Finalizing or amending an already finalized node is rejected.
    assert_eq!(
        client.try_finalize_result(&bracket_id, &0),
        Err(Ok(Error::AlreadyResolved))
    );
    assert_eq!(
        client.try_amend_result(&bracket_id, &0, &p1, &reviewer),
        Err(Ok(Error::AlreadyResolved))
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
        client.try_amend_result(&locked_bracket, &0, &p2, &admin),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_finalize_result(&locked_bracket, &0),
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

#[test]
fn test_construction_and_advancement_reject_identical_participants_in_both_slots() {
    let (env, contract_id, client, admin) = setup();
    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let p3 = Address::generate(&env);

    // 1. Seeded bracket construction rejects identical participants in the same match.
    assert_eq!(
        client.try_create_seeded_bracket(&2, &vec![&env, p1.clone(), p1.clone()]),
        Err(Ok(Error::DuplicateParticipant))
    );

    // 2. Seeded bracket construction rejects duplicate participants across matches.
    assert_eq!(
        client.try_create_seeded_bracket(&4, &vec![&env, p1.clone(), p2.clone(), p1.clone()]),
        Err(Ok(Error::DuplicateParticipant))
    );

    // 3. Incremental registration rejects duplicate participant in the second slot.
    let bracket_id = client.create_bracket(&4);
    client.register(&bracket_id, &p1);
    assert_eq!(
        client.try_register(&bracket_id, &p1),
        Err(Ok(Error::AlreadyRegistered))
    );

    // 4. Advancement rejects placing a participant into a parent node whose opposite
    //    slot already holds the same participant.
    client.register(&bracket_id, &p2);
    client.register(&bracket_id, &p3);
    client.lock_registration(&bracket_id, &admin);

    // Parent node 2 currently has slot2 = Filled(p3) (via bye from node 1) and slot1 = Vacant.
    // If node 0 is corrupted to carry p3 vs p2 and p3 is finalized, advancing p3 into
    // parent node 2 slot1 would place p3 on both sides of node 2 and must fail with
    // Error::DuplicateParticipant.
    env.as_contract(&contract_id, || {
        let mut node0 = BracketContract::load_node(&env, bracket_id, 0).unwrap();
        node0.slot1 = Slot::Filled(p3.clone());
        node0.slot2 = Slot::Filled(p2.clone());
        BracketContract::save_node(&env, &node0);
    });

    client.submit_result(&bracket_id, &0, &p3, &admin);
    advance_ledger(&env, DEFAULT_REVIEW_WINDOW_LEDGERS);
    assert_eq!(
        client.try_finalize_result(&bracket_id, &0),
        Err(Ok(Error::DuplicateParticipant))
    );

    // Verify parent node 2 was never mutated to hold p3 on both sides.
    let final_node = client.get_node(&bracket_id, &2);
    assert_eq!(final_node.slot1, Slot::Vacant);
    assert_eq!(final_node.slot2, Slot::Filled(p3));
}

#[test]
fn prop_distinct_participants_across_all_supported_bracket_sizes_and_byes() {
    let (env, _contract_id, client, admin) = setup();
    let sizes: [u32; 8] = [2, 4, 8, 16, 32, 64, 128, 256];

    for size in sizes {
        // Exercise multiple bye distributions for each supported power-of-two size:
        // single entrant (all byes), sparse/odd entrant count (mixed byes and void nodes),
        // and three-quarters full.
        let entrant_counts: [u32; 3] = [1, (size / 2) + 1, size - 1];

        for count in entrant_counts {
            let mut participants: Vec<Address> = Vec::new(&env);
            for _ in 0..count {
                participants.push_back(Address::generate(&env));
            }

            let bracket_id = client.create_seeded_bracket(&size, &participants);
            client.lock_registration(&bracket_id, &admin);

            let bracket = client.get_bracket(&bracket_id);
            for round in 0..bracket.rounds {
                let nodes_in_round = size >> (round + 1);
                let round_offset = size - (size >> round);
                let mut seen_in_round: Vec<Address> = Vec::new(&env);

                for index in 0..nodes_in_round {
                    let node_id = (round_offset + index) as u64;
                    let node = client.get_node(&bracket_id, &node_id);

                    // Invariant 1: No node ever holds the same participant in slot1 and slot2.
                    if let (Slot::Filled(a), Slot::Filled(b)) = (&node.slot1, &node.slot2) {
                        assert_ne!(a, b, "duplicate participant in node {}", node_id);
                    }

                    // Invariant 2: No participant appears more than once in the same round.
                    for slot in [&node.slot1, &node.slot2] {
                        if let Slot::Filled(addr) = slot {
                            for i in 0..seen_in_round.len() {
                                assert_ne!(
                                    seen_in_round.get(i).unwrap(),
                                    *addr,
                                    "participant duplicated in round {}",
                                    round
                                );
                            }
                            seen_in_round.push_back(addr.clone());
                        }
                    }

                    // Resolve any playable match so winners advance into the next round.
                    if client.get_node_state(&bracket_id, &node_id) == NodeState::Ready {
                        let winner = match (&node.slot1, &node.slot2) {
                            (Slot::Filled(p1), Slot::Filled(p2)) => {
                                if (index + round) % 2 == 0 {
                                    p1.clone()
                                } else {
                                    p2.clone()
                                }
                            }
                            _ => unreachable!(),
                        };
                        client.submit_result(&bracket_id, &node_id, &winner, &admin);
                        advance_ledger(&env, DEFAULT_REVIEW_WINDOW_LEDGERS);
                        client.finalize_result(&bracket_id, &node_id);
                    }
                }
            }

            // A champion must be crowned from the registered participants.
            let champion = client.get_champion(&bracket_id);
            let mut found = false;
            for i in 0..participants.len() {
                if participants.get(i).unwrap() == champion {
                    found = true;
                    break;
                }
            }
            assert!(found);
        }
    }
}
