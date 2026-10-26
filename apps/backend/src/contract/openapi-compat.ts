/**
 * Breaking-change check for the backend's OpenAPI contract (#117).
 *
 * Compares the contract on the base branch with the one in a change and
 * lists every difference that can break an existing consumer. See
 * docs/api-compatibility.md for the policy this enforces.
 *
 * Breaking:
 * - an operation (path + method) or a documented response status removed;
 * - an operation newly requiring authentication or a request body;
 * - a response property removed, no longer always present, or its type changed;
 * - a response enum gaining a value (existing clients won't handle it);
 * - a request property newly required, a request type narrowed, or a request
 *   enum value no longer accepted;
 * - an error code removed from `ErrorCode`.
 *
 * Additive changes are allowed: new operations, new response statuses, new
 * optional request properties, new response properties, new error codes.
 *
 * A breaking change is accepted only with a new major `info.version`.
 */

type Json = Record<string, unknown>;

export interface CompatResult {
  breaking: string[];
  baseVersion: string;
  headVersion: string;
  /** True when breaking changes exist and the major version was not raised. */
  failed: boolean;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(spec: Json, schema: unknown, depth = 0): Json {
  if (!isObject(schema) || depth > 20) return {};
  const ref = schema.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    let node: unknown = spec;
    for (const part of ref.slice(2).split('/')) node = isObject(node) ? node[part] : undefined;
    return resolve(spec, node, depth + 1);
  }
  return schema;
}

function types(schema: Json): string[] {
  const t = schema.type;
  return (Array.isArray(t) ? t : t === undefined ? [] : [t]).map(String).sort();
}

function enumValues(schema: Json): unknown[] | null {
  return Array.isArray(schema.enum) ? schema.enum : null;
}

function required(schema: Json): Set<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
}

function properties(schema: Json): Json {
  return isObject(schema.properties) ? schema.properties : {};
}

/** Response schema compatibility: the head must still provide everything the base promised. */
function compareResponse(
  base: Json,
  head: Json,
  baseSpec: Json,
  headSpec: Json,
  where: string,
  out: string[],
  depth = 0,
): void {
  const b = resolve(baseSpec, base);
  const h = resolve(headSpec, head);
  if (depth > 10) return;
  const bt = types(b);
  const ht = types(h);
  if (bt.length > 0 && ht.length > 0 && ht.some((t) => !bt.includes(t))) {
    out.push(`${where}: type changed from ${bt.join('|')} to ${ht.join('|')}`);
  }
  const be = enumValues(b);
  const he = enumValues(h);
  // New error codes are additive by policy: clients must handle unknown codes.
  const isErrorCode = typeof base.$ref === 'string' && base.$ref.endsWith('/ErrorCode');
  if (be && he && !isErrorCode) {
    const added = he.filter((v) => !be.some((x) => JSON.stringify(x) === JSON.stringify(v)));
    if (added.length > 0)
      out.push(
        `${where}: response enum gained ${JSON.stringify(added)} that existing clients don't handle`,
      );
  }
  const breq = required(b);
  const hreq = required(h);
  const hprops = properties(h);
  for (const [name, schema] of Object.entries(properties(b))) {
    if (!(name in hprops)) {
      out.push(`${where}.${name}: response property removed`);
      continue;
    }
    if (breq.has(name) && !hreq.has(name))
      out.push(`${where}.${name}: response property no longer always present`);
    compareResponse(
      schema as Json,
      hprops[name] as Json,
      baseSpec,
      headSpec,
      `${where}.${name}`,
      out,
      depth + 1,
    );
  }
}

/** Request schema compatibility: every request valid under the base must stay valid. */
function compareRequest(
  base: Json,
  head: Json,
  baseSpec: Json,
  headSpec: Json,
  where: string,
  out: string[],
  depth = 0,
): void {
  const b = resolve(baseSpec, base);
  const h = resolve(headSpec, head);
  if (depth > 10) return;
  const bt = types(b);
  const ht = types(h);
  if (bt.length > 0 && ht.length > 0 && bt.some((t) => !ht.includes(t))) {
    out.push(`${where}: accepted type narrowed from ${bt.join('|')} to ${ht.join('|')}`);
  }
  const be = enumValues(b);
  const he = enumValues(h);
  if (be && he) {
    const removed = be.filter((v) => !he.some((x) => JSON.stringify(x) === JSON.stringify(v)));
    if (removed.length > 0)
      out.push(`${where}: request enum no longer accepts ${JSON.stringify(removed)}`);
  }
  const breq = required(b);
  for (const name of required(h)) {
    if (!breq.has(name)) out.push(`${where}.${name}: request property is newly required`);
  }
  const hprops = properties(h);
  for (const [name, schema] of Object.entries(properties(b))) {
    if (name in hprops)
      compareRequest(
        schema as Json,
        hprops[name] as Json,
        baseSpec,
        headSpec,
        `${where}.${name}`,
        out,
        depth + 1,
      );
  }
}

function jsonSchema(container: unknown): Json | null {
  if (!isObject(container) || !isObject(container.content)) return null;
  const json = container.content['application/json'];
  return isObject(json) && isObject(json.schema) ? json.schema : null;
}

function major(version: string): number {
  const match = /^(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

/** List breaking changes from `base` to `head`. */
export function findBreakingChanges(base: Json, head: Json): string[] {
  const out: string[] = [];
  const bPaths = isObject(base.paths) ? base.paths : {};
  const hPaths = isObject(head.paths) ? head.paths : {};

  for (const [route, bItem] of Object.entries(bPaths)) {
    const hItem = hPaths[route];
    for (const method of METHODS) {
      const bOp = isObject(bItem) ? bItem[method] : undefined;
      if (!isObject(bOp)) continue;
      const hOp = isObject(hItem) ? hItem[method] : undefined;
      const where = `${method.toUpperCase()} ${route}`;
      if (!isObject(hOp)) {
        out.push(`${where}: operation removed`);
        continue;
      }
      if (hOp.security && !bOp.security) out.push(`${where}: now requires authentication`);

      const bBody = jsonSchema(bOp.requestBody);
      const hBody = jsonSchema(hOp.requestBody);
      if (bBody && hBody) compareRequest(bBody, hBody, base, head, `${where} request`, out);
      else if (!bBody && hBody && isObject(hOp.requestBody) && hOp.requestBody.required) {
        out.push(`${where}: now requires a request body`);
      }

      const bResponses = isObject(bOp.responses) ? bOp.responses : {};
      const hResponses = isObject(hOp.responses) ? hOp.responses : {};
      for (const [status, bResp] of Object.entries(bResponses)) {
        const hResp = hResponses[status];
        if (!hResp) {
          out.push(`${where}: response ${status} removed`);
          continue;
        }
        const bSchema = jsonSchema(bResp);
        const hSchema = jsonSchema(hResp);
        if (bSchema && hSchema)
          compareResponse(bSchema, hSchema, base, head, `${where} ${status}`, out);
      }
    }
  }

  const codes = (spec: Json) =>
    enumValues(resolve(spec, { $ref: '#/components/schemas/ErrorCode' })) ?? [];
  const headCodes = codes(head);
  for (const code of codes(base)) {
    if (!headCodes.includes(code)) out.push(`ErrorCode ${String(code)}: error code removed`);
  }
  return out;
}

/** Compare two contracts and apply the versioning rule. */
export function checkCompatibility(base: Json, head: Json): CompatResult {
  const breaking = findBreakingChanges(base, head);
  const baseVersion = String((base.info as Json | undefined)?.version ?? '0.0.0');
  const headVersion = String((head.info as Json | undefined)?.version ?? '0.0.0');
  return {
    breaking,
    baseVersion,
    headVersion,
    failed: breaking.length > 0 && major(headVersion) <= major(baseVersion),
  };
}
