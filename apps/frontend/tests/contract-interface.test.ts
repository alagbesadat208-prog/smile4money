/**
 * Frontend contract bindings vs the shared interface fixture (#120).
 *
 * contracts/interface/contract-interface.json is generated from the contract
 * sources; the backend tests its bindings against the same file. Any drift
 * in a method name, argument order or type, or an error code fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { xdr } from '@stellar/stellar-sdk';
import {
  CONTRACT_INTERFACE_SPEC_HASH,
  ESCROW_ERRORS,
  FRONTEND_METHODS,
  LEADERBOARD_ERRORS,
  escrowErrorName,
  leaderboardErrorName,
  serializeGetLeaderboardArgs,
  serializeGetMatchArgs,
} from '../src/contract/contract-interface';

interface FixtureMethod {
  name: string;
  args: { name: string; type: string }[];
  returns: string;
}
interface FixtureContract {
  methods: FixtureMethod[];
  errors: { name: string; code: number }[];
  enums: { name: string; variants: string[] }[];
}
interface Fixture {
  schemaVersion: number;
  specHash: string;
  contracts: Record<'escrow' | 'leaderboard', FixtureContract>;
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../contracts/interface/contract-interface.json'), 'utf8'),
) as Fixture;

/** ScVal arm each fixture type must serialize to. */
const SCVAL_ARM: Record<string, string> = {
  u32: 'scvU32',
  u64: 'scvU64',
  i128: 'scvI128',
  bool: 'scvBool',
  String: 'scvString',
  Address: 'scvAddress',
};

function method(contract: 'escrow' | 'leaderboard', name: string): FixtureMethod {
  const found = fixture.contracts[contract].methods.find((m) => m.name === name);
  if (!found) throw new Error(`${contract}.${name} is not in the contract interface fixture`);
  return found;
}

function expectArgsMatch(contract: 'escrow' | 'leaderboard', name: string, args: xdr.ScVal[]) {
  const spec = method(contract, name);
  expect(args).toHaveLength(spec.args.length);
  spec.args.forEach((arg, i) => {
    expect([arg.name, args[i].switch().name]).toEqual([arg.name, SCVAL_ARM[arg.type]]);
  });
}

describe('frontend contract bindings (#120)', () => {
  it('were reviewed against the current fixture', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(CONTRACT_INTERFACE_SPEC_HASH).toBe(fixture.specHash);
  });

  it('call methods that exist, with the contract argument order', () => {
    for (const [contract, methods] of Object.entries(FRONTEND_METHODS) as [
      'escrow' | 'leaderboard',
      Record<string, readonly string[]>,
    ][]) {
      for (const [name, argNames] of Object.entries(methods)) {
        expect(method(contract, name).args.map((a) => a.name)).toEqual([...argNames]);
      }
    }
  });

  it('serialize get_match arguments with the contract types', () => {
    expectArgsMatch('escrow', 'get_match', serializeGetMatchArgs(42));
    expect(serializeGetMatchArgs(42n)[0].u64().toString()).toBe('42');
  });

  it('serialize get_leaderboard arguments with the contract types', () => {
    const args = serializeGetLeaderboardArgs(10, 20);
    expectArgsMatch('leaderboard', 'get_leaderboard', args);
    expect([args[0].u32(), args[1].u32()]).toEqual([10, 20]);
  });

  it('use exactly the escrow error codes', () => {
    expect(Object.entries(ESCROW_ERRORS)).toEqual(
      fixture.contracts.escrow.errors.map((e) => [e.name, e.code]),
    );
  });

  it('use exactly the leaderboard error codes', () => {
    expect(Object.entries(LEADERBOARD_ERRORS)).toEqual(
      fixture.contracts.leaderboard.errors.map((e) => [e.name, e.code]),
    );
  });

  it('decode error codes to names', () => {
    expect(escrowErrorName(1)).toBe('MatchNotFound');
    expect(escrowErrorName(9)).toBe('ContractPaused');
    expect(escrowErrorName(9999)).toBeUndefined();
    expect(leaderboardErrorName(5)).toBe('InvalidRange');
    for (const { name, code } of fixture.contracts.leaderboard.errors) {
      expect(leaderboardErrorName(code)).toBe(name);
    }
  });
});
