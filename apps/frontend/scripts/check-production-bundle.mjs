import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const bundleDirectory = resolve(process.argv[2] ?? 'dist');
const serverOnlyNames = [
  'ORACLE_SECRET_KEY',
  'JWT_SECRET',
  'LICHESS_API_TOKEN',
  'CHESSDOTCOM_API_KEY',
  'DEPLOYER_SECRET_KEY',
  'MAINNET_DEPLOYER_SECRET_KEY',
  'MONGODB_URL',
];
const serverOnlyValues = serverOnlyNames
  .map((name) => process.env[name])
  .filter((value) => value && value.length >= 8);

if (!existsSync(bundleDirectory) || !statSync(bundleDirectory).isDirectory()) {
  throw new Error(`Production bundle directory does not exist: ${bundleDirectory}`);
}

const files = [];
function collectFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path);
    else files.push(path);
  }
}
collectFiles(bundleDirectory);

const violations = [];
for (const file of files) {
  const contents = readFileSync(file, 'utf8');
  for (const name of serverOnlyNames) {
    if (contents.includes(name)) {
      violations.push(`${file}: contains server-only variable name ${name}`);
    }
  }
  for (const value of serverOnlyValues) {
    if (contents.includes(value)) {
      violations.push(`${file}: contains a server-only variable value`);
    }
  }
}

if (violations.length > 0) {
  console.error('Production bundle contains server-only configuration:');
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(
  `Production bundle scan passed: ${files.length} files checked; no server-only configuration found.`,
);
