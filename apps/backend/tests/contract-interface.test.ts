/**
 * Backend contract bindings vs the shared interface fixture (#120).
 *
 * contracts/interface/contract-interface.json is generated from the contract
 * sources; the frontend tests its bindings against the same file. This suite
 * also checks the fixture itself is up to date with the contracts.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair, Address, type xdr } from '@stellar/stellar-sdk';
import {
  BACKEND_ESCROW_METHODS,
  CONTRACT_INTERFACE_SPEC_HASH,
  ESCROW_ERRORS,
  ESCROW_WINNERS,
  LEADERBOARD_ERRORS,
  escrowErrorName,
  leaderboardErrorName,
  serializeSubmitResultArgs,
  toEscrowWinner,
} from '../src/contract/contract-interface.js';

interface FixtureContract {
  methods: { name: string; args: { name: string; type: string }[]; returns: string }[];
  errors: { name: string; code: number }[];
  enums: { name: string; variants: string[] }[];
}
interface Fixture {
  schemaVersion: number;
  specHash: string;
  contracts: Record<'escrow' | 'leaderboard', FixtureContract>;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../contracts/interface/contract-interface.json', import.meta.url)),
    'utf8',
  ),
) as Fixture;

const escrow = fixture.contracts.escrow;
const enumNames = new Set(escrow.enums.map((e) => e.name));

/** ScVal arm each fixture type must serialize to; unit enums are vectors. */
function scValArm(type: string): string {
  if (enumNames.has(type)) return 'scvVec';
  const arms: Record<string, string> = {
    u32: 'scvU32',
    u64: 'scvU64',
    i128: 'scvI128',
    bool: 'scvBool',
    String: 'scvString',
    Address: 'scvAddress',
  };
  return arms[type];
}

function escrowMethod(name: string) {
  const found = escrow.methods.find((m) => m.name === name);
  if (!found) throw new Error(`escrow.${name} is not in the contract interface fixture`);
  return found;
}

describe('contract interface fixture (#120)', () => {
  it('is up to date with the contract sources', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/generate-contract-interface.mjs', '--check'], {
        cwd: repoRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});

describe('backend contract bindings (#120)', () => {
  it('were reviewed against the current fixture', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(CONTRACT_INTERFACE_SPEC_HASH).toBe(fixture.specHash);
  });

  it('call escrow methods that exist, with the contract argument order', () => {
    for (const [name, argNames] of Object.entries(BACKEND_ESCROW_METHODS)) {
      expect(escrowMethod(name).args.map((a) => a.name)).toEqual([...argNames]);
    }
  });

  it('serialize submit_result arguments with the contract types', () => {
    const caller = Keypair.random().publicKey();
    const args: xdr.ScVal[] = serializeSubmitResultArgs({
      matchId: 7,
      gameId: 'abcd1234',
      result: 'Player2Wins',
      caller,
    });
    const spec = escrowMethod('submit_result');
    expect(args).toHaveLength(spec.args.length);
    spec.args.forEach((arg, i) => {
      expect([arg.name, args[i].switch().name]).toEqual([arg.name, scValArm(arg.type)]);
    });
    expect(args[0].u64().toString()).toBe('7');
    expect(args[1].str().toString()).toBe('abcd1234');
    expect(args[2].vec()?.[0].sym().toString()).toBe('Player2');
    expect(Address.fromScVal(args[3]).toString()).toBe(caller);
  });

  it('map every backend result to a Winner variant the contract defines', () => {
    const winner = escrow.enums.find((e) => e.name === 'Winner');
    expect(winner?.variants).toEqual([...ESCROW_WINNERS]);
    for (const result of ['Player1Wins', 'Player2Wins', 'Draw'] as const) {
      expect(winner?.variants).toContain(toEscrowWinner(result));
    }
  });

  it('use exactly the escrow error codes', () => {
    expect(Object.entries(ESCROW_ERRORS)).toEqual(escrow.errors.map((e) => [e.name, e.code]));
  });

  it('use exactly the leaderboard error codes', () => {
    expect(Object.entries(LEADERBOARD_ERRORS)).toEqual(
      fixture.contracts.leaderboard.errors.map((e) => [e.name, e.code]),
    );
  });

  it('decode error codes to names', () => {
    expect(escrowErrorName(4)).toBe('Unauthorized');
    expect(escrowErrorName(13)).toBe('GameIdMismatch');
    expect(escrowErrorName(0)).toBeUndefined();
    for (const { name, code } of fixture.contracts.leaderboard.errors) {
      expect(leaderboardErrorName(code)).toBe(name);
    }
  });
});
