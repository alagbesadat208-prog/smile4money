# Contract registry

The registry accepts names containing 1–32 lowercase ASCII letters, digits,
hyphens, and underscores. A name must start with a lowercase letter. Names
are case-sensitive by policy and are never normalized; uppercase, whitespace,
punctuation, non-ASCII bytes, and the reserved names `admin`, `system`, and
`registry` are rejected.

The administrator is the sole owner of registry records. Only the administrator
can register, update, or deregister entries. Updating a record increments its
revision and records the ledger at which that revision became effective.

`health` is a read-only operation that returns whether the registry is
initialized, its schema version, the public administrator address, and the
network identifier. It returns schema version 0 before initialization and
reports legacy initialized instances without a schema marker as version 1.
The administrator can call `migrate` to mark a legacy instance as the current
schema (version 2). No secret configuration is included in this response.
