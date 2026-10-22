import { readFile } from "node:fs/promises";
import { Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { OracleSubmission } from "./oracle-submit.js";

export interface SignerProvider {
  getAuthorizedSigner(): Promise<Keypair>;
}

/** Read the mounted secret on every attempt; never persist a signer in a job. */
export class ManagedSignerProvider implements SignerProvider {
  constructor(
    private loadSecret: () => Promise<string>,
    private loadAdmin: () => Promise<string>,
  ) {}

  async getAuthorizedSigner(): Promise<Keypair> {
    const signer = Keypair.fromSecret((await this.loadSecret()).trim());
    if (signer.publicKey() !== (await this.loadAdmin())) {
      throw new Error(
        "Current oracle signer does not hold the on-chain admin role",
      );
    }
    return signer;
  }
}

/** Read the active admin, not PendingAdmin, from the oracle's instance storage. */
export async function readOracleAdmin(
  server: rpc.Server,
  contractId: string,
): Promise<string> {
  const entry = await server.getContractData(
    contractId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
  );
  const storage = entry.val.contractData().val().instance().storage() ?? [];
  const state = storage.find((item) => {
    const key = scValToNative(item.key());
    return Array.isArray(key) && key.length === 1 && key[0] === "InstanceState";
  });
  if (!state) throw new Error("Oracle contract is not initialized");
  const admin = scValToNative(state.val()).admin;
  if (typeof admin !== "string")
    throw new Error("Oracle admin role is unavailable");
  return admin;
}

export function createManagedSignerProvider(
  server: rpc.Server,
  contractId: string,
): SignerProvider {
  return new ManagedSignerProvider(
    async () => {
      const file = process.env.ORACLE_SIGNER_SECRET_FILE;
      if (!file) throw new Error("ORACLE_SIGNER_SECRET_FILE is required");
      return readFile(file, "utf8");
    },
    () => readOracleAdmin(server, contractId),
  );
}

export function managedSubmissionHandler(
  provider: SignerProvider,
  submit: (submission: OracleSubmission, signer: Keypair) => Promise<void>,
): (submission: OracleSubmission) => Promise<void> {
  return async (submission) => {
    const signer = await provider.getAuthorizedSigner();
    await submit(submission, signer);
  };
}
