#!/usr/bin/env node
/**
 * Generates the contract-interface fixture shared by the frontend and backend
 * (#120): contracts/interface/contract-interface.json.
 *
 * It reads each contract's Rust source and records the public contract
 * methods (name, argument names and types, return type), the contract error
 * codes and the unit enums used as arguments. Both clients test their
 * serializers against this one file, so a contract change that is not
 * reflected in a client fails that client's tests instead of failing on-chain.
 *
 * Usage:
 *   node scripts/generate-contract-interface.mjs          # write the fixture
 *   node scripts/generate-contract-interface.mjs --check  # exit 1 if it is stale
 *
 * No dependencies: the source is parsed with plain text rules that match how
 * the contracts are written (one `#[contractimpl]` block per contract, methods
 * taking `env: Env` first, `#[contracterror]` enums with explicit codes).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTERFACE_SCHEMA_VERSION = 1;
export const CONTRACTS = ['escrow', 'leaderboard'];
export const FIXTURE_PATH = 'contracts/interface/contract-interface.json';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Drop `//` comments so braces and commas inside them are not parsed. */
function stripLineComments(source) {
  return source.replace(/\/\/[^\n]*/g, '');
}

/** Index just past the brace that closes the one at `open`. */
function matchingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced braces');
}

/** Split on commas that are not inside `<...>` or `(...)`. */
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '<' || ch === '(') depth++;
    if (ch === '>' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Public methods of the `#[contractimpl]` block in `lib.rs`. */
export function parseMethods(libSource) {
  const source = stripLineComments(libSource);
  const marker = source.indexOf('#[contractimpl]');
  if (marker === -1) throw new Error('no #[contractimpl] block');
  const open = source.indexOf('{', marker);
  const body = source.slice(open + 1, matchingBrace(source, open) - 1);

  const methods = new Map();
  const duplicates = [];
  const fnPattern = /\bpub fn (\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{/g;
  let match;
  while ((match = fnPattern.exec(body))) {
    const [, name, rawParams, rawReturn] = match;
    const params = splitTopLevel(rawParams).map((param) => {
      const [argName, ...type] = param.split(':');
      return { name: argName.trim(), type: type.join(':').trim() };
    });
    // Only `env: Env` methods are exported; `&Env` ones are internal helpers.
    if (params[0]?.name !== 'env' || params[0]?.type !== 'Env') continue;
    const method = {
      name,
      args: params.slice(1),
      returns: rawReturn ? rawReturn.replace(/\s+/g, ' ').trim() : '()',
    };
    if (methods.has(name)) {
      duplicates.push(name);
      continue;
    }
    methods.set(name, method);
  }
  return {
    methods: [...methods.values()].sort((a, b) => a.name.localeCompare(b.name)),
    duplicates,
  };
}

function enumBody(source, attribute, name) {
  const pattern = new RegExp(`#\\[${attribute}\\][^]*?pub enum ${name ?? '(\\w+)'}\\s*\\{`, 'g');
  const results = [];
  let match;
  while ((match = pattern.exec(source))) {
    // Skip a match whose attribute belongs to an earlier item.
    const between = match[0].slice(attribute.length + 3);
    if (/\b(struct|enum|fn|impl)\b/.test(between.replace(/pub enum \w+\s*\{$/, ''))) continue;
    const open = match.index + match[0].length - 1;
    results.push({
      name: name ?? match[1],
      body: source.slice(open + 1, matchingBrace(source, open) - 1),
    });
  }
  return results;
}

/** `Name = code` entries of the contract's `#[contracterror]` enum. */
export function parseErrors(sources) {
  for (const source of sources) {
    const [found] = enumBody(stripLineComments(source), 'contracterror');
    if (!found) continue;
    return [...found.body.matchAll(/(\w+)\s*=\s*(\d+)/g)].map(([, name, code]) => ({
      name,
      code: Number(code),
    }));
  }
  return [];
}

/** `#[contracttype]` enums whose variants are all unit variants. */
export function parseUnitEnums(sources) {
  const enums = [];
  for (const source of sources) {
    for (const { name, body } of enumBody(stripLineComments(source), 'contracttype')) {
      const variants = splitTopLevel(body.replace(/#\[[^\]]*\]/g, ''));
      if (variants.length === 0 || !variants.every((v) => /^\w+$/.test(v))) continue;
      enums.push({ name, variants });
    }
  }
  return enums.sort((a, b) => a.name.localeCompare(b.name));
}

function rustSources(contractDir) {
  const src = join(contractDir, 'src');
  return readdirSync(src)
    .filter((f) => f.endsWith('.rs') && !f.startsWith('tests'))
    .sort()
    .map((f) => readFileSync(join(src, f), 'utf8'));
}

/** Build the fixture object from the contract sources under `root`. */
export function buildInterface(root = ROOT) {
  const contracts = {};
  const warnings = [];
  for (const name of CONTRACTS) {
    const dir = join(root, 'contracts', name);
    const sources = rustSources(dir);
    const { methods, duplicates } = parseMethods(readFileSync(join(dir, 'src', 'lib.rs'), 'utf8'));
    const errors = parseErrors(sources);
    for (const dup of duplicates) warnings.push(`${name}: method ${dup} is defined more than once`);
    const seen = new Map();
    for (const { name: errName, code } of errors) {
      if (seen.has(code))
        warnings.push(`${name}: error code ${code} is used by ${seen.get(code)} and ${errName}`);
      else seen.set(code, errName);
    }
    contracts[name] = { methods, errors, enums: parseUnitEnums(sources) };
  }
  const specHash = createHash('sha256')
    .update(JSON.stringify(contracts))
    .digest('hex')
    .slice(0, 16);
  return {
    fixture: {
      schemaVersion: INTERFACE_SCHEMA_VERSION,
      specHash,
      generatedBy: 'scripts/generate-contract-interface.mjs',
      contracts,
    },
    warnings,
  };
}

export function serialize(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const { fixture, warnings } = buildInterface();
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  const target = join(ROOT, FIXTURE_PATH);
  const next = serialize(fixture);

  if (check) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // Missing fixture is stale.
    }
    if (current !== next) {
      console.error(
        `${FIXTURE_PATH} is out of date. Run: node scripts/generate-contract-interface.mjs`,
      );
      process.exit(1);
    }
    console.log(`${FIXTURE_PATH} is up to date (specHash ${fixture.specHash}).`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`Wrote ${FIXTURE_PATH} (specHash ${fixture.specHash}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
