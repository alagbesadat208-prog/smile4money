# Public Status Page

During an RPC, provider or oracle incident, participants need one authoritative place that tells a service outage apart from a failed wager. That place is `GET /status` on the backend (#115). It is unauthenticated, cached for 30 seconds, and safe to render directly on a public status site or in the frontend.

## Components

| Component | Source | Meaning |
|---|---|---|
| `stellar_rpc`, Stellar network (Soroban RPC) | RPC circuit breaker | `outage` while the breaker is open, `degraded` while it is recovering |
| `oracle_submissions`, Result submission | Retry queue depth | `degraded` while results are waiting to be submitted. Funds stay in escrow meanwhile. |
| `lichess`, Lichess game data | Incidents | Set by operators |
| `chessdotcom`, Chess.com game data | Incidents | Set by operators |

Each component is `operational`, `degraded`, `outage` or `unknown` (the signal couldn't be read). `overall` is the worst of them. An active incident raises its components to the incident's impact. Resolved incidents stay listed for 7 days.

## What is never published

The document is built from an allowlist of fields, never from raw errors or configuration. Any text that looks like a Stellar key (`G…`, `S…`, `C…`, `M…` StrKeys) is replaced with `[redacted]` before it is published, including text an operator typed into an incident. Never put signer names, key IDs, hosts or internal URLs in incident text anyway.

## Owner and update procedure

**Owner:** the on-call engineer (see the runbook's contact escalation list). The engineering lead is the backup.

Incidents live in a JSON file on the backend host, `apps/backend/data/status-incidents.json`; override the path with `STATUS_INCIDENTS_FILE`. Edits take effect on the next request, with no restart.

```json
{
  "incidents": [
    {
      "id": "2026-10-22-lichess",
      "title": "Lichess game data unavailable",
      "stage": "investigating",
      "impact": "outage",
      "components": ["lichess"],
      "startedAt": "2026-10-22T11:00:00Z",
      "updates": [
        { "at": "2026-10-22T11:05:00Z", "message": "We can't read games from Lichess. Matches played there will settle once it is back; stakes are safe in escrow." }
      ]
    }
  ]
}
```

| When | Do |
|---|---|
| An alarm fires or a component shows `degraded`/`outage` | Within **15 minutes**, add an incident with `stage: "investigating"` and a first update saying what players see and that funds are safe. |
| Every **60 minutes** while it is open, or whenever something changes | Add an update. Move `stage` through `identified` and `monitoring` as appropriate. |
| Fixed | Set `stage: "resolved"`, add `resolvedAt` and a final update. |
| Within 2 business days | Link the post-incident report in a final update for major incidents. |

`stage` is one of `investigating`, `identified`, `monitoring` or `resolved`. `impact` is `degraded` or `outage`. `components` uses the IDs above. Malformed entries are dropped rather than published.

## Publishing

Point the public status site, or the frontend's banner, at `GET /status` on the production backend. The response shape is part of the API contract (`apps/backend/openapi.json`, `PublicStatus`). Host the status site separately from the frontend, so it stays up when the frontend doesn't.
