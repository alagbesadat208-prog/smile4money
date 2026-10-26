import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { redactSensitiveFields } from "../src/middleware/request-logging.js";
afterEach(() => {
  vi.unstubAllEnvs();
});
it("keeps sponsorship disabled unless explicitly enabled on the server", async () => {
  vi.stubEnv("FEE_SPONSOR_ENABLED", "false");
  const response = await request(app)
    .post("/api/transactions/sponsor")
    .send({ optIn: true, signedTxXdr: "invalid" });
  expect(response.status).toBe(503);
});
it("requires player consent and never returns sponsor secrets on rejection", async () => {
  vi.stubEnv("FEE_SPONSOR_ENABLED", "true");
  vi.stubEnv("FEE_SPONSOR_SECRET", "private-value-never-return");
  expect(
    (
      await request(app)
        .post("/api/transactions/sponsor")
        .send({ signedTxXdr: "invalid" })
    ).status,
  ).toBe(400);
  const response = await request(app)
    .post("/api/transactions/sponsor")
    .send({ optIn: true, signedTxXdr: "invalid" });
  expect(response.status).toBe(400);
  expect(response.text).not.toContain("private-value-never-return");
  expect(response.body).toEqual({
    error: expect.stringContaining("Sponsorship rejected"),
  });
});
it("redacts signed inner envelopes before request logging", () => {
  expect(
    redactSensitiveFields({ signedTxXdr: "signed-envelope", optIn: true }),
  ).toEqual({ signedTxXdr: "[REDACTED]", optIn: true });
});
