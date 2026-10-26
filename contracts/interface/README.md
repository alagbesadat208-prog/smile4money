# Contract Interface Fixture

`contract-interface.json` is the one description of the deployed contracts' interface that every client is tested against (#120). It is generated from the contract sources, never edited by hand:

```sh
node scripts/generate-contract-interface.mjs          # regenerate
node scripts/generate-contract-interface.mjs --check  # fail if stale
```

It records, for the `escrow` and `leaderboard` contracts:

- **methods**: every `pub fn` in the `#[contractimpl]` block that takes `env: Env`, with argument names and Rust types in order, and the return type;
- **errors**: the `#[contracterror]` enum, as `name` and numeric `code`;
- **enums**: `#[contracttype]` enums with only unit variants (e.g. `Winner`, `Platform`), which clients encode as one-symbol vectors.

`schemaVersion` is the fixture format version. `specHash` is a hash of the recorded interface, so it changes whenever a method, argument, error or enum changes.

## Who checks it

| Client | Binding | Test |
|---|---|---|
| Backend | `apps/backend/src/contract/contract-interface.ts` | `apps/backend/tests/contract-interface.test.ts`, which also runs `--check` |
| Frontend | `apps/frontend/src/contract/contract-interface.ts` | `apps/frontend/tests/contract-interface.test.ts` |

Both tests require each binding's error table to equal the fixture's, each method it calls to exist with the same argument order, and each serializer to produce the ScVal type the contract expects. Each binding also pins the `specHash` it was reviewed against.

## Changing a contract's interface

1. Change the contract.
2. Regenerate the fixture and commit it with the contract change.
3. The backend and frontend contract-interface tests now fail on `specHash`, and on anything that actually drifted. Update both bindings, then set `CONTRACT_INTERFACE_SPEC_HASH` in each to the new `specHash`.

The generator prints a warning for problems it finds in the source, such as a method defined twice or two errors sharing a code. These are recorded as written; fix them in the contract.
