import { describe, it, expect } from "vitest";
import {
  NetworkConfigError,
  resolveNetworkConfig,
} from "../src/config/network.js";
import { NETWORKS } from "../src/config/networks.generated.js";

/** The backend resolves its network from the canonical table and rejects conflicting identities (#118). */

const CONTRACT = "C" + "A".repeat(55);

describe("resolveNetworkConfig", () => {
  it("defaults to testnet and its canonical endpoint and passphrase", () => {
    expect(resolveNetworkConfig({})).toEqual({
      network: "testnet",
      networkPassphrase: NETWORKS.testnet.networkPassphrase,
      rpcUrl: NETWORKS.testnet.rpcUrl,
      rpcUrlOverridden: false,
      contracts: { escrow: null, oracle: null },
    });
  });

  it("uses the named network", () => {
    const r = resolveNetworkConfig({ STELLAR_NETWORK: "mainnet" });
    expect(r.rpcUrl).toBe(NETWORKS.mainnet.rpcUrl);
    expect(r.networkPassphrase).toBe(NETWORKS.mainnet.networkPassphrase);
  });

  it("accepts a private RPC node for the same network", () => {
    const r = resolveNetworkConfig({
      STELLAR_NETWORK: "mainnet",
      STELLAR_RPC_URL: "https://rpc.internal.example/soroban",
    });
    expect(r).toMatchObject({
      rpcUrl: "https://rpc.internal.example/soroban",
      rpcUrlOverridden: true,
    });
  });

  it("treats .env.example placeholders as unset", () => {
    const r = resolveNetworkConfig({
      CONTRACT_ESCROW: "YOUR_CONTRACT_ESCROW_ID_HERE",
      STELLAR_RPC_URL: "",
    });
    expect(r.contracts.escrow).toBeNull();
    expect(r.rpcUrlOverridden).toBe(false);
  });

  it.each([
    [
      "an unknown network",
      { STELLAR_NETWORK: "moonnet" },
      /Unknown Stellar network "moonnet"/,
    ],
    [
      "mainnet pointed at the testnet RPC",
      { STELLAR_NETWORK: "mainnet", STELLAR_RPC_URL: NETWORKS.testnet.rpcUrl },
      /testnet's RPC endpoint/,
    ],
    [
      "testnet pointed at the mainnet RPC",
      { STELLAR_NETWORK: "testnet", STELLAR_RPC_URL: NETWORKS.mainnet.rpcUrl },
      /mainnet's RPC endpoint/,
    ],
    [
      "a passphrase from another network",
      {
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: NETWORKS.testnet.networkPassphrase,
      },
      /does not belong to mainnet/,
    ],
  ])("rejects %s", (_label, env, message) => {
    expect(() => resolveNetworkConfig(env)).toThrow(NetworkConfigError);
    expect(() => resolveNetworkConfig(env)).toThrow(message);
  });

  it("accepts a contract id when the table has none for that network", () => {
    expect(
      resolveNetworkConfig({ CONTRACT_ESCROW: CONTRACT }).contracts.escrow,
    ).toBe(CONTRACT);
  });
});
