import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { fetchLichessResult } from "../../src/fetchers/lichess.js";
import { fetchChessDotComResult } from "../../src/fetchers/chessdotcom.js";
import { ProviderSchemaError } from "../../src/errors/ProviderSchemaError.js";
import type { MatchResult } from "../../src/fetchers/lichess.js";

/**
 * Runs the real parsers over the sanitized payloads in tests/fixtures/providers
 * (issue #121). axios is mocked, and fetch is stubbed to throw, so nothing here
 * can reach the network.
 */
vi.mock("axios");
const mockedAxios = vi.mocked(axios);

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "providers",
);

function load(provider: "lichess" | "chessdotcom", name: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES, provider, `${name}.json`), "utf8"),
  );
}

function fixtureNames(provider: "lichess" | "chessdotcom"): string[] {
  return readdirSync(join(FIXTURES, provider))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function serve(body: unknown) {
  mockedAxios.get = vi
    .fn()
    .mockResolvedValue({ status: 200, data: body, headers: {} });
}

type Expected = MatchResult | null | "schema-error";

const LICHESS: Record<string, Expected> = {
  "decisive-white-mate": "Player1Wins",
  "decisive-black-resign": "Player2Wins",
  "decisive-black-outoftime-anonymous-white": "Player2Wins",
  "draw-agreed": "Draw",
  "draw-stalemate": "Draw",
  "ongoing-started": null,
  "malformed-missing-players": "schema-error",
  "malformed-winner-type": "schema-error",
  "changed-schema-additive": "Player2Wins",
  "changed-schema-renamed-players": "schema-error",
};

/** [game id to look up, expected outcome] per archive. */
const CHESSDOTCOM: Record<string, Array<[string, Expected]>> = {
  "archive-decisive": [
    ["100000001", "Player1Wins"],
    ["100000002", "Player2Wins"],
    ["100000003", "Player2Wins"],
    ["100000004", "Player1Wins"],
  ],
  "archive-draw": [
    ["100000011", "Draw"],
    ["100000012", "Draw"],
    ["100000013", "Draw"],
    ["100000014", "Draw"],
    ["100000015", "Draw"],
    ["100000016", "Draw"],
  ],
  "archive-ongoing": [["100000021", null]],
  // The broken entry fails; a valid game in the same archive still parses.
  "archive-malformed-game": [
    ["100000031", "schema-error"],
    ["100000032", "Player1Wins"],
  ],
  "archive-malformed-body": [["100000041", "schema-error"]],
  "archive-changed-schema-additive": [["100000051", "Player2Wins"]],
  "archive-changed-schema-unknown-code": [["100000061", "schema-error"]],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", () => {
    throw new Error("network access is not allowed in fixture tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectOutcome(
  run: () => Promise<{ result: MatchResult | null }>,
  expected: Expected,
) {
  if (expected === "schema-error") {
    await expect(run()).rejects.toBeInstanceOf(ProviderSchemaError);
  } else {
    expect((await run()).result).toBe(expected);
  }
}

describe("Lichess fixtures", () => {
  it("every fixture file has an expected outcome, and every expectation has a file", () => {
    expect(fixtureNames("lichess")).toEqual(Object.keys(LICHESS).sort());
  });

  it.each(Object.entries(LICHESS))("%s → %s", async (name, expected) => {
    const body = load("lichess", name) as { id?: string };
    serve(body);
    await expectOutcome(
      () => fetchLichessResult(body.id ?? "fxLi0000"),
      expected,
    );
  });

  it('maps an anonymous (AI) player to "unknown" instead of crashing', async () => {
    serve(load("lichess", "decisive-black-outoftime-anonymous-white"));
    const result = await fetchLichessResult("fxLi0003");
    expect(result.whitePlayer).toBe("unknown");
    expect(result.blackPlayer).toBe("fixture-black");
  });

  it("only ever called the mocked transport", async () => {
    serve(load("lichess", "decisive-white-mate"));
    await fetchLichessResult("fxLi0001");
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});

describe("Chess.com fixtures", () => {
  it("every fixture file has an expected outcome, and every expectation has a file", () => {
    expect(fixtureNames("chessdotcom")).toEqual(
      Object.keys(CHESSDOTCOM).sort(),
    );
  });

  const cases = Object.entries(CHESSDOTCOM).flatMap(([name, games]) =>
    games.map(([gameId, expected]) => [name, gameId, expected] as const),
  );

  it.each(cases)("%s game %s → %s", async (name, gameId, expected) => {
    serve(load("chessdotcom", name));
    await expectOutcome(
      () => fetchChessDotComResult("fixture-white", gameId),
      expected,
    );
  });

  it("reports a finished game as finished and an ongoing one as in_progress", async () => {
    serve(load("chessdotcom", "archive-decisive"));
    expect(
      (await fetchChessDotComResult("fixture-white", "100000001")).status,
    ).toBe("finished");
    serve(load("chessdotcom", "archive-ongoing"));
    expect(
      (await fetchChessDotComResult("fixture-white", "100000021")).status,
    ).toBe("in_progress");
  });
});

describe("fixture privacy", () => {
  const files = (["lichess", "chessdotcom"] as const).flatMap((p) =>
    fixtureNames(p).map(
      (name) =>
        [
          p,
          name,
          readFileSync(join(FIXTURES, p, `${name}.json`), "utf8"),
        ] as const,
    ),
  );

  it.each(files)(
    "%s/%s contains no personal data or secrets",
    (_provider, _name, text) => {
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // email
      expect(text).not.toMatch(/\b(?:lip|lio)_[A-Za-z0-9]{8,}/); // Lichess token
      expect(text).not.toMatch(
        /bearer\s|authorization|api[_-]?key|secret|password/i,
      );
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/); // IPv4
    },
  );

  it.each(files)(
    "%s/%s only names fixture players",
    (_provider, _name, text) => {
      const names = [
        ...text.matchAll(/"(?:name|username|id)":\s*"([^"]+)"/g),
      ].map((m) => m[1]);
      for (const value of names) {
        expect(value).toMatch(/^(?:fixture-(?:white|black)|fxLi\d{4})$/);
      }
    },
  );
});
