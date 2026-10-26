import { afterAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

vi.mock("../src/store/index.js", async () => {
  const { SqliteMatchStore } =
    await import("../src/store/sqlite-match-store.js");
  const matchStore = new SqliteMatchStore(":memory:");
  await matchStore.initialize();
  return { matchStore };
});
import router from "../src/routes/matches.js";
import { matchStore } from "../src/store/index.js";
const app = express();
app.use(express.json());
app.use("/api/matches", router);
const token = jwt.sign(
  { address: "wallet-a" },
  process.env.JWT_SECRET || "test-secret",
);
beforeEach(() => matchStore.clear());
afterAll(() => matchStore.close());

it("requires authentication to unlink", async () => {
  expect((await request(app).delete("/api/matches/identities")).status).toBe(
    401,
  );
});
it("unlinks only the authenticated wallet, ignoring wallet parameters", async () => {
  const payload = {
    player1: "wallet-a",
    player2: "wallet-b",
    player1Username: "alice",
    player2Username: "bob",
    stakeAmount: 1,
    token: "asset",
    gameId: "one",
    platform: "lichess",
  };
  await matchStore.createMatch(payload);
  await matchStore.createMatch({
    ...payload,
    player1: "wallet-c",
    player2: "wallet-d",
    gameId: "two",
  });
  expect(
    (
      await request(app)
        .delete("/api/matches/identities")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: "wallet-c" })
    ).status,
  ).toBe(204);
  expect(
    (await matchStore.findByGameId("one"))?.player1Username,
  ).toBeUndefined();
  expect((await matchStore.findByGameId("two"))?.player1Username).toBe("alice");
});
