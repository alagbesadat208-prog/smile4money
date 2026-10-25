import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import axios from "axios";
import {
  childContext,
  contextFromHeaders,
  currentTraceContext,
  formatTraceparent,
  newTraceContext,
  parseTraceparent,
  persistTraceContext,
  resumeTraceContext,
  runWithTraceContext,
  sanitizeTraceState,
  traceHeaders,
  traceLogFields,
} from "../../src/tracing/trace-context.js";
import { traceContext } from "../../src/middleware/trace-context.js";
import {
  closeQueue,
  initializeQueue,
  listDlqEntries,
  removeDlqEntry,
  startRetryWorker,
  writeToDlq,
} from "../../src/queue.js";
import { resetCircuitBreaker } from "../../src/services/circuit-breaker.js";
import { SQLiteQueueStore } from "../../src/store/sqlite-queue-store.js";
import { PollingJobStore, PollingWorker } from "../../src/services/polling.js";
import { fetchLichessResult } from "../../src/fetchers/lichess.js";
import { createStellarRpcClient } from "../../src/services/stellar.js";

/** Trace context propagation through HTTP, durable queues and outbound calls (issue #123). */

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN}-01`;

// Values that must never appear in a persisted trace or an outbound header.
const STELLAR_SECRET =
  "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
const LICHESS_TOKEN = "lip_FixtureToken1234567890";
// Joined at runtime so scripts/check-secrets.sh doesn't flag a fake token.
const JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJmaXh0dXJlIn0",
  "c2lnbmF0dXJl",
].join(".");

describe("traceparent parsing", () => {
  it("accepts a valid header", () => {
    expect(parseTraceparent(TRACEPARENT)).toEqual({
      traceId: TRACE_ID,
      spanId: PARENT_SPAN,
      flags: "01",
    });
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseTraceparent(`  ${TRACEPARENT.toUpperCase()} `)?.traceId).toBe(
      TRACE_ID,
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["all-zero trace id", `00-${"0".repeat(32)}-${PARENT_SPAN}-01`],
    ["all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["forbidden version ff", `ff-${TRACE_ID}-${PARENT_SPAN}-01`],
    ["short trace id", `00-${TRACE_ID.slice(1)}-${PARENT_SPAN}-01`],
    ["non-hex", `00-${"z".repeat(32)}-${PARENT_SPAN}-01`],
    ["extra field", `${TRACEPARENT}-extra`],
  ])("rejects %s", (_label, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });

  it("round-trips through formatTraceparent", () => {
    const ctx = newTraceContext();
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      flags: "01",
    });
  });
});

describe("tracestate sanitising", () => {
  it("keeps well-formed vendor members", () => {
    expect(sanitizeTraceState("rojo=00f067aa0ba902b7, congo=t61rcWkgMzE")).toBe(
      "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE",
    );
  });

  it.each([
    ["a Stellar secret seed", `wallet=${STELLAR_SECRET}`],
    ["a Lichess token", `x=${LICHESS_TOKEN}`],
    ["a JWT", `s=${JWT}`],
    ["a credential-named key", "apikey=abc123"],
    ["a token-named key", "authtoken=abc123"],
  ])("drops a member carrying %s", (_label, member) => {
    expect(sanitizeTraceState(`rojo=1,${member}`)).toBe("rojo=1");
  });

  it("drops malformed members and duplicates, and keeps the first occurrence", () => {
    expect(sanitizeTraceState("rojo=1,=bad,NoUpper=1,rojo=2,ok=")).toBe(
      "rojo=1",
    );
  });

  it("caps the list at 32 members and 512 characters", () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `k${i}=${"v".repeat(20)}`,
    ).join(",");
    const kept = sanitizeTraceState(many)!;
    expect(kept.split(",").length).toBeLessThanOrEqual(32);
    expect(kept.length).toBeLessThanOrEqual(512);
  });

  it("returns undefined when nothing survives", () => {
    expect(sanitizeTraceState(`secret=${STELLAR_SECRET}`)).toBeUndefined();
  });
});

describe("context helpers", () => {
  it("continues an incoming trace as a child span", () => {
    const ctx = contextFromHeaders(TRACEPARENT, "rojo=1");
    expect(ctx.traceId).toBe(TRACE_ID);
    expect(ctx.parentSpanId).toBe(PARENT_SPAN);
    expect(ctx.spanId).not.toBe(PARENT_SPAN);
    expect(ctx.traceState).toBe("rojo=1");
  });

  it("starts a new trace for an invalid header and ignores its tracestate", () => {
    const ctx = contextFromHeaders("garbage", "rojo=1");
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.traceId).not.toBe(TRACE_ID);
    expect(ctx.traceState).toBeUndefined();
  });

  it("exposes the active context only inside runWithTraceContext, across awaits", async () => {
    const ctx = newTraceContext();
    expect(currentTraceContext()).toBeUndefined();
    await runWithTraceContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentTraceContext()).toBe(ctx);
      expect(traceLogFields()).toEqual({
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
      });
    });
    expect(currentTraceContext()).toBeUndefined();
    expect(traceHeaders()).toEqual({});
  });

  it("resumes persisted work as a new span under the same trace each time", () => {
    const persisted = persistTraceContext(
      contextFromHeaders(TRACEPARENT, null),
    )!;
    const first = resumeTraceContext(persisted);
    const second = resumeTraceContext(persisted);
    expect(first.traceId).toBe(TRACE_ID);
    expect(second.traceId).toBe(TRACE_ID);
    expect(first.spanId).not.toBe(second.spanId);
    expect(first.parentSpanId).toBe(second.parentSpanId);
  });

  it("starts a fresh trace for missing or corrupted persisted context", () => {
    expect(resumeTraceContext(undefined).traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(resumeTraceContext({ traceparent: "nope" }).traceId).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });

  it("childContext keeps trace id, flags and state", () => {
    const parent = { ...newTraceContext(), flags: "00", traceState: "rojo=1" };
    const child = childContext(parent);
    expect(child).toMatchObject({
      traceId: parent.traceId,
      flags: "00",
      traceState: "rojo=1",
      parentSpanId: parent.spanId,
    });
  });
});

describe("HTTP middleware", () => {
  function app() {
    const a = express();
    a.use(traceContext());
    a.get("/ctx", (_req, res) => {
      res.json(currentTraceContext());
    });
    return a;
  }

  it("continues the caller trace and echoes the server span", async () => {
    const res = await request(app())
      .get("/ctx")
      .set("traceparent", TRACEPARENT)
      .set("tracestate", "rojo=1");
    expect(res.body.traceId).toBe(TRACE_ID);
    expect(res.body.parentSpanId).toBe(PARENT_SPAN);
    expect(res.headers.traceparent).toBe(
      `00-${TRACE_ID}-${res.body.spanId}-01`,
    );
  });

  it("starts a trace when the caller sends none", async () => {
    const res = await request(app()).get("/ctx");
    expect(res.headers.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    expect(res.body.parentSpanId).toBeUndefined();
  });

  it("strips secrets a client smuggles into tracestate", async () => {
    const res = await request(app())
      .get("/ctx")
      .set("traceparent", TRACEPARENT)
      .set("tracestate", `rojo=1,w=${STELLAR_SECRET},t=${LICHESS_TOKEN}`);
    expect(res.body.traceState).toBe("rojo=1");
  });
});

describe("DLQ propagation (in-memory store)", () => {
  beforeEach(async () => {
    process.env.QUEUE_STORE = "memory";
    resetCircuitBreaker();
    await initializeQueue();
    for (const e of await listDlqEntries()) await removeDlqEntry(e.id);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeQueue();
  });

  it("persists the active trace with the entry", async () => {
    const ctx = contextFromHeaders(TRACEPARENT, "rojo=1");
    await runWithTraceContext(ctx, () =>
      writeToDlq({ matchId: 1 }, "RPC timeout"),
    );
    const [entry] = await listDlqEntries();
    expect(entry.traceContext).toEqual({
      traceparent: formatTraceparent(ctx),
      tracestate: "rojo=1",
    });
  });

  it("starts a trace for work queued outside any request", async () => {
    await writeToDlq({ matchId: 2 }, "RPC timeout");
    const [entry] = await listDlqEntries();
    expect(entry.traceContext?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  it("resumes the trace on every retry, with a new span per attempt", async () => {
    vi.useFakeTimers();
    const ctx = contextFromHeaders(TRACEPARENT, null);
    await runWithTraceContext(ctx, () =>
      writeToDlq({ matchId: 3 }, "RPC timeout"),
    );

    const seen: Array<ReturnType<typeof currentTraceContext>> = [];
    const handler = vi.fn(async () => {
      seen.push(currentTraceContext());
      throw new Error("still failing");
    });
    const stop = startRetryWorker(handler, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s?.traceId).toBe(TRACE_ID);
      expect(s?.parentSpanId).toBe(ctx.spanId);
    }
    expect(seen[0]?.spanId).not.toBe(seen[1]?.spanId);
  });
});

describe("DLQ propagation (SQLite store)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "smile4money-trace-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("survives a restart: the trace context is read back from disk", async () => {
    const dbPath = path.join(dir, "queue.db");
    const persisted = persistTraceContext(
      contextFromHeaders(TRACEPARENT, "rojo=1"),
    )!;
    const writer = new SQLiteQueueStore(dbPath);
    await writer.initialize();
    await writer.add({
      id: "e1",
      payload: { matchId: 1 },
      failureReason: "x",
      attempts: 0,
      createdAt: Date.now(),
      lastAttemptAt: null,
      traceContext: persisted,
    });
    await writer.close();

    const reader = new SQLiteQueueStore(dbPath);
    await reader.initialize();
    const [entry] = await reader.getAll();
    await reader.close();
    expect(entry.traceContext).toEqual(persisted);
  });

  it("migrates a pre-#123 table and reads old rows without a context", async () => {
    const dbPath = path.join(dir, "legacy.db");
    await new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.serialize(() => {
        db.run(`CREATE TABLE oracle_dlq (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, failureReason TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastAttemptAt INTEGER, expireAt INTEGER NOT NULL)`);
        db.run(
          `INSERT INTO oracle_dlq VALUES ('old', '{}', 'x', 0, ?, NULL, ?)`,
          [Date.now(), Date.now() + 86_400_000],
        );
        db.close((err) => (err ? reject(err) : resolve()));
      });
    });

    const store = new SQLiteQueueStore(dbPath);
    await store.initialize();
    await store.add({
      id: "new",
      payload: {},
      failureReason: "x",
      attempts: 0,
      createdAt: Date.now() + 1,
      lastAttemptAt: null,
      traceContext: { traceparent: TRACEPARENT },
    });
    const entries = await store.getAll();
    await store.close();

    expect(entries.find((e) => e.id === "old")?.traceContext).toBeUndefined();
    expect(entries.find((e) => e.id === "new")?.traceContext).toEqual({
      traceparent: TRACEPARENT,
    });
  });
});

describe("polling jobs", () => {
  it("captures the creating request trace and polls inside it", async () => {
    const store = new PollingJobStore();
    const ctx = contextFromHeaders(TRACEPARENT, null);
    runWithTraceContext(ctx, () => store.createJob(1, "g1", "lichess"));

    const seen: Array<ReturnType<typeof currentTraceContext>> = [];
    const worker = new PollingWorker(
      store,
      {
        poll: async () => {
          seen.push(currentTraceContext());
          return { status: "in_progress" };
        },
      },
      {
        pollingIntervalMs: 60_000,
        onGameCompleted: async () => {},
        onMaxAttemptsExceeded: async () => {},
      },
    );
    await (worker as unknown as { pollAllJobs(): Promise<void> }).pollAllJobs();
    worker.stop?.();

    expect(seen[0]?.traceId).toBe(TRACE_ID);
    expect(seen[0]?.parentSpanId).toBe(ctx.spanId);
  });
});

describe("outbound calls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LICHESS_API_TOKEN;
  });

  it("sends traceparent to the provider, and the credential only in Authorization", async () => {
    process.env.LICHESS_API_TOKEN = LICHESS_TOKEN;
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {},
      data: { id: "g1", status: "started", players: { white: {}, black: {} } },
    });
    const ctx = contextFromHeaders(TRACEPARENT, `rojo=1,t=${LICHESS_TOKEN}`);
    await runWithTraceContext(ctx, () => fetchLichessResult("g1"));

    const headers = (
      get.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers;
    expect(headers.traceparent).toBe(formatTraceparent(ctx));
    expect(headers.tracestate).toBe("rojo=1");
    const { Authorization: _auth, ...rest } = headers;
    expect(JSON.stringify(rest)).not.toContain(LICHESS_TOKEN);
  });

  it("adds trace headers to Stellar RPC requests made inside a context", async () => {
    const client = createStellarRpcClient({ timeoutMs: 1_000 });
    let sent: Record<string, unknown> = {};
    client.defaults.adapter = async (config) => {
      sent = config.headers.toJSON();
      return { data: {}, status: 200, statusText: "OK", headers: {}, config };
    };
    const ctx = newTraceContext();
    await runWithTraceContext(ctx, () => client.post("http://rpc.invalid", {}));
    expect(sent.traceparent).toBe(formatTraceparent(ctx));

    await client.post("http://rpc.invalid", {});
    expect(sent.traceparent).toBeUndefined();
  });
});

describe("no secrets in traces", () => {
  beforeEach(async () => {
    process.env.QUEUE_STORE = "memory";
    await initializeQueue();
    for (const e of await listDlqEntries()) await removeDlqEntry(e.id);
  });
  afterEach(async () => {
    await closeQueue();
  });

  it("a hostile tracestate never reaches the persisted entry, the logs, or outbound headers", async () => {
    const lines: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => void lines.push(String(line)));
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((line: string) => void lines.push(String(line)));

    const ctx = contextFromHeaders(
      TRACEPARENT,
      `rojo=1,seed=${STELLAR_SECRET},x=${STELLAR_SECRET},jwt=${JWT},t=${LICHESS_TOKEN}`,
    );
    await runWithTraceContext(ctx, () =>
      writeToDlq({ matchId: 9 }, "RPC timeout"),
    );
    const [entry] = await listDlqEntries();
    const outbound = runWithTraceContext(
      resumeTraceContext(entry.traceContext),
      () => traceHeaders(),
    );
    log.mockRestore();
    warn.mockRestore();

    const everything =
      JSON.stringify(entry.traceContext) +
      JSON.stringify(outbound) +
      lines.join("\n");
    for (const secret of [STELLAR_SECRET, JWT, LICHESS_TOKEN]) {
      expect(everything).not.toContain(secret);
    }
    expect(Object.keys(entry.traceContext!).sort()).toEqual([
      "traceparent",
      "tracestate",
    ]);
    expect(lines.some((l) => l.includes(TRACE_ID))).toBe(true);
  });
});
