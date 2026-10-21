import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/services/stellar.js", () => ({ checkStellarRpc: vi.fn() }));
vi.mock("../../src/services/bottleneck-limiters.js", () => ({
  getAllLimiterStats: vi.fn(() => ({})),
}));

import { runHealthCheck } from "../../src/services/health-service.js";
import {
  SettlementAgeMonitor,
  setSettlementAgeMonitor,
} from "../../src/services/settlement-age-monitor.js";

const BASE = { uptimeSeconds: 1, version: "test" };

afterEach(() => {
  setSettlementAgeMonitor(null);
});

describe("runHealthCheck settlement metrics", () => {
  it("omits settlement data by default, even when a monitor is registered", async () => {
    const monitor = new SettlementAgeMonitor();
    monitor.recordStage(1, "activated");
    setSettlementAgeMonitor(monitor);

    const result = await runHealthCheck(BASE);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.settlement).toBeUndefined();
  });

  it("includes the settlement snapshot when requested", async () => {
    const monitor = new SettlementAgeMonitor();
    monitor.recordStage(1, "activated");
    setSettlementAgeMonitor(monitor);

    const result = await runHealthCheck({ ...BASE, includeSettlement: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.settlement?.openMatches).toBe(1);
      expect(result.payload.settlement?.open.provider_wait.count).toBe(1);
    }
  });

  it("reports null when requested but no monitor is active", async () => {
    const result = await runHealthCheck({ ...BASE, includeSettlement: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.settlement).toBeNull();
  });
});
