import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { OracleSubmission } from "./oracle-submit.js";

/** A transport accepts the already authorized signer for this attempt only. */
export class OracleContractTransport {
  constructor(
    private server: rpc.Server,
    private contractId: string,
    private networkPassphrase: string,
    private wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  async hasResult(matchId: number): Promise<boolean> {
    // Read-only simulation needs no funded source account and no private key.
    const source = new Account(Keypair.random().publicKey(), "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        new Contract(this.contractId).call(
          "has_result",
          nativeToScVal(BigInt(matchId), { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error("Oracle result lookup failed");
    }
    const exists = scValToNative(simulation.result.retval);
    if (typeof exists !== "boolean")
      throw new Error("Oracle result lookup returned an invalid value");
    return exists;
  }

  async submit(submission: OracleSubmission, signer: Keypair): Promise<void> {
    if (
      !Number.isSafeInteger(submission.matchId) ||
      submission.matchId <= 0 ||
      !["Player1Wins", "Player2Wins", "Draw"].includes(submission.result) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(submission.gameId)
    ) {
      throw new Error("Invalid oracle submission");
    }
    const source = await this.server.getAccount(signer.publicKey());
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        new Contract(this.contractId).call(
          "submit_result",
          nativeToScVal(BigInt(submission.matchId), { type: "u64" }),
          nativeToScVal(submission.gameId, { type: "string" }),
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(submission.result)]),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
    if (!["PENDING", "DUPLICATE"].includes(sent.status))
      throw new Error("Oracle RPC rejected submission");
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
      if (result.status === rpc.Api.GetTransactionStatus.FAILED)
        throw new Error("Oracle transaction failed");
      await this.wait(1000);
    }
    throw new Error("Oracle transaction confirmation pending");
  }
}

export function oracleNetworkPassphrase(env = process.env): string {
  if (env.STELLAR_NETWORK_PASSPHRASE) return env.STELLAR_NETWORK_PASSPHRASE;
  switch (env.STELLAR_NETWORK ?? "testnet") {
    case "testnet":
      return Networks.TESTNET;
    case "mainnet":
      return Networks.PUBLIC;
    default:
      throw new Error(
        "Set STELLAR_NETWORK_PASSPHRASE for a custom Stellar network",
      );
  }
}
