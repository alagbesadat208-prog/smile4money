/**
 * CI check: fail when apps/backend/openapi.json changes incompatibly (#117).
 *
 *   tsx src/cli/openapi-compat.ts <base-openapi.json> <head-openapi.json>
 *
 * A missing base file (the contract is new on this branch) passes.
 * See docs/api-compatibility.md.
 */
import fs from 'fs';
import { checkCompatibility } from '../contract/openapi-compat.js';

export function run(basePath: string | undefined, headPath: string | undefined): number {
  if (!basePath || !headPath) {
    console.error('usage: openapi-compat <base-openapi.json> <head-openapi.json>');
    return 2;
  }
  if (!fs.existsSync(basePath) || fs.statSync(basePath).size === 0) {
    console.log('No base contract to compare against; nothing to check.');
    return 0;
  }
  const result = checkCompatibility(
    JSON.parse(fs.readFileSync(basePath, 'utf8')),
    JSON.parse(fs.readFileSync(headPath, 'utf8')),
  );
  if (result.breaking.length === 0) {
    console.log(`No breaking changes (${result.baseVersion} -> ${result.headVersion}).`);
    return 0;
  }
  const list = result.breaking.map((b) => `  - ${b}`).join('\n');
  if (result.failed) {
    console.error(
      `Breaking API changes without a major version bump (${result.baseVersion} -> ${result.headVersion}):\n${list}\n` +
        'Make the change additive, or raise info.version to the next major and follow the deprecation policy in docs/api-compatibility.md.',
    );
    return 1;
  }
  console.log(`Breaking changes accepted with major version ${result.headVersion}:\n${list}`);
  return 0;
}

if (process.argv[1] && /openapi-compat\.(ts|js)$/.test(process.argv[1])) {
  process.exit(run(process.argv[2], process.argv[3]));
}
