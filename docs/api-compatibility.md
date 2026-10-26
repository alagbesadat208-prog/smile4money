# API Compatibility Policy

How the backend's HTTP API changes without breaking the frontend or third-party consumers (#117).

## The contract

`apps/backend/openapi.json` (OpenAPI 3.1) is the published contract: every route, request body, response status and response schema, and the full list of error codes. `apps/backend/tests/openapi-contract.test.ts` fails if a route is mounted but not documented, or documented but not mounted, or if the error codes drift from `src/errors/errorResponse.ts`.

## Versioning

`info.version` follows semantic versioning:

| Change | Version | Example |
|---|---|---|
| Breaking (see below) | **Major** | Removing a response field |
| Additive | Minor | A new endpoint, a new optional request field, a new response field |
| Documentation or fixes that don't change the schema | Patch | Clarifying a description |

## What counts as breaking

The CI check (`src/contract/openapi-compat.ts`) compares the pull request's contract with the base branch's and flags:

- **Operations:** an operation removed, or a documented response status removed.
- **Auth and bodies:** an operation newly requiring authentication or a request body.
- **Response properties:** a response property removed, no longer always present, or changing type.
- **Response enums:** a response enum gaining a value, because existing clients won't handle it. `ErrorCode` is the exception: clients must treat an unknown error code like a generic failure of its HTTP status.
- **Requests:** a request property newly required, a request type narrowed, or a request enum value no longer accepted.
- **Error codes:** an error code removed.

A breaking change fails CI unless `info.version`'s major number is raised in the same pull request.

Some semantic changes break consumers without changing the schema, for example a field whose meaning changes, or an error returned in a new situation. They need the same treatment: raise the major version and follow the deprecation rules.

## Deprecation

1. **Mark it.** Mark the field or operation `deprecated: true` in `openapi.json` and say what replaces it.
2. **Announce it.** Put it in the changelog and the release notes, with a removal date at least **90 days** away. For a breaking change to a response the frontend uses, ship the frontend change first.
3. **Remove it.** Keep serving the deprecated field or operation until the removal date. Then remove it in a release that raises the major version.

## Consumer obligations

- Ignore response fields you don't know.
- Handle unknown error codes by HTTP status.
- Don't depend on the order of object keys or on undocumented fields.

## Running the check locally

```sh
cd apps/backend
git show origin/master:apps/backend/openapi.json > /tmp/base-openapi.json
npx tsx src/cli/openapi-compat.ts /tmp/base-openapi.json openapi.json
```
