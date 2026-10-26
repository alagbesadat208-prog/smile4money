import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import logger from "../src/logger.js";
import { requestLogging } from "../src/middleware/request-logging.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([200, 500])(
  "does not expose secrets or linkable identifiers on HTTP %s, even at debug level",
  async (status) => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      lines.push(String(value));
    });
    const app = express();
    app.use(express.json());
    app.use(requestLogging());
    app.post("/wallet/:address", (req, res) => {
      logger[status === 200 ? "info" : "error"](
        {
          ...req.body,
          headers: req.headers,
          error: new Error("token-secret wallet-secret player-secret"),
          nested: { proof: "proof-secret" },
          method: "player-secret",
          count: "token-secret",
          message: "override-secret",
          timestamp: "override-secret",
        },
        "http_request",
      );
      res.sendStatus(status);
    });
    await request(app)
      .post("/wallet/wallet-secret?token=token-secret")
      .set("Authorization", "Bearer token-secret")
      .send({
        username: "player-secret",
        walletAddress: "wallet-secret",
        providerToken: "token-secret",
      });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toMatch(
      /token-secret|wallet-secret|player-secret|proof-secret|override-secret/,
    );
    const summary = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.status);
    expect(summary.status).toBe(status);
    expect(summary.method).toBe("POST");
  },
);

it("masks unapproved event messages and serializes neither error objects nor nested context", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  logger.error(
    { error: new Error("secret"), arbitrary: { token: "secret" }, status: 500 },
    "secret",
  );
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    message: "log_event",
    status: 500,
  });
  expect(log.mock.calls[0][0]).not.toContain("secret");
});
