/**
 * OpenAPI contract and compatibility check (#117).
 *
 * The contract (openapi.json) must describe every route the app mounts and
 * every error code it can return, and the compatibility checker must flag
 * changes that break existing consumers. See docs/api-compatibility.md.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ErrorCode } from '../src/errors/errorResponse.js';
import { checkCompatibility, findBreakingChanges } from '../src/contract/openapi-compat.js';
import { run } from '../src/cli/openapi-compat.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(root, 'openapi.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(spec));

/** "METHOD /full/path" for every route mounted in app.ts. */
function mountedRoutes(): string[] {
  const app = fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8');
  const routes: string[] = [];
  for (const [, prefix, routerName] of app.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)) {
    const importLine = new RegExp(`import ${routerName} from '\\./routes/([\\w-]+)\\.js'`).exec(
      app,
    );
    if (!importLine) continue;
    const source = fs.readFileSync(path.join(root, 'src/routes', `${importLine[1]}.ts`), 'utf8');
    for (const [, method, sub] of source.matchAll(
      /router\.(get|post|put|patch|delete)\('([^']*)'/g,
    )) {
      const full = (prefix + (sub === '/' ? '' : sub)).replace(/\/$/, '') || '/';
      routes.push(`${method.toUpperCase()} ${full}`);
    }
  }
  return routes.sort();
}

function documentedRoutes(): string[] {
  const out: string[] = [];
  for (const [route, item] of Object.entries(
    spec.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const method of Object.keys(item)) out.push(`${method.toUpperCase()} ${route}`);
  }
  return out.sort();
}

describe('openapi.json', () => {
  it('documents exactly the routes the app mounts', () => {
    const mounted = mountedRoutes();
    expect(mounted.length).toBeGreaterThan(0);
    expect(documentedRoutes()).toEqual(mounted);
  });

  it('lists every error code the API returns', () => {
    expect([...spec.components.schemas.ErrorCode.enum].sort()).toEqual(
      Object.values(ErrorCode).sort(),
    );
  });

  it('has a semantic version', () => {
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('compatibility check', () => {
  it('passes an unchanged contract', () => {
    expect(checkCompatibility(spec, clone())).toMatchObject({ breaking: [], failed: false });
  });

  it('allows additive changes', () => {
    const head = clone();
    head.components.schemas.Match.properties.createdAt = { type: 'string' };
    head.components.schemas.CreateMatchRequest.properties.note = { type: 'string' };
    head.components.schemas.ErrorCode.enum.push('FORBIDDEN');
    head.paths['/api/matches'].get = { responses: { '200': { description: 'list' } } };
    expect(findBreakingChanges(spec, head)).toEqual([]);
  });

  it('flags a removed operation and a removed response status', () => {
    const head = clone();
    delete head.paths['/api/validate-game'];
    delete head.paths['/health'].get.responses['503'];
    expect(findBreakingChanges(spec, head)).toEqual(
      expect.arrayContaining([
        'POST /api/validate-game: operation removed',
        'GET /health: response 503 removed',
      ]),
    );
  });

  it('flags a removed or no-longer-guaranteed response field and a type change', () => {
    const head = clone();
    delete head.components.schemas.Match.properties.gameId;
    head.components.schemas.Match.required = head.components.schemas.Match.required.filter(
      (f: string) => f !== 'token' && f !== 'gameId',
    );
    head.components.schemas.Match.properties.matchId = { type: 'string' };
    const breaking = findBreakingChanges(spec, head);
    expect(breaking).toContain('POST /api/matches 201.gameId: response property removed');
    expect(breaking).toContain(
      'POST /api/matches 201.token: response property no longer always present',
    );
    expect(breaking).toContain(
      'POST /api/matches 201.matchId: type changed from integer to string',
    );
  });

  it('flags a newly required request field and a narrowed request enum', () => {
    const head = clone();
    head.components.schemas.ValidateGameRequest.required.push('username');
    head.components.schemas.Platform.enum = ['lichess'];
    const breaking = findBreakingChanges(spec, head);
    expect(breaking).toContain(
      'POST /api/validate-game request.username: request property is newly required',
    );
    expect(breaking).toEqual(
      expect.arrayContaining([
        'POST /api/validate-game request.platform: request enum no longer accepts ["chessdotcom"]',
      ]),
    );
  });

  it('flags a removed error code and newly required authentication', () => {
    const head = clone();
    head.components.schemas.ErrorCode.enum = head.components.schemas.ErrorCode.enum.filter(
      (c: string) => c !== 'CONFLICT',
    );
    head.paths['/api/validate-game'].post.security = [{ bearerAuth: [] }];
    const breaking = findBreakingChanges(spec, head);
    expect(breaking).toContain('ErrorCode CONFLICT: error code removed');
    expect(breaking).toContain('POST /api/validate-game: now requires authentication');
  });

  it('accepts a breaking change only with a new major version', () => {
    const head = clone();
    delete head.paths['/api/validate-game'];
    expect(checkCompatibility(spec, head).failed).toBe(true);
    head.info.version = '1.1.0';
    expect(checkCompatibility(spec, head).failed).toBe(true);
    head.info.version = '2.0.0';
    expect(checkCompatibility(spec, head)).toMatchObject({ failed: false, headVersion: '2.0.0' });
  });
});

describe('openapi-compat CLI', () => {
  const write = (dir: string, name: string, value: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };

  it('exits 1 on an unversioned breaking change and 0 otherwise', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-compat-'));
    const head = clone();
    delete head.paths['/health'];
    expect(run(write(dir, 'base.json', spec), write(dir, 'same.json', spec))).toBe(0);
    expect(run(write(dir, 'base.json', spec), write(dir, 'head.json', head))).toBe(1);
    expect(run(path.join(dir, 'missing.json'), write(dir, 'head.json', head))).toBe(0);
    expect(run(undefined, undefined)).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
});
