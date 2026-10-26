import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { GameResult } from "../fetchers/lichess.js";
import type { MatchRecord } from "../store/match-store.js";
import type { SubmitResultInput } from "./oracle-service.js";

export interface SettlementEvidence {
  version: 1;
  input: SubmitResultInput;
  match: MatchRecord;
  game: GameResult;
}
export function evidenceDirectory() {
  return process.env.SETTLEMENT_EVIDENCE_DIR ?? "data/settlement-evidence";
}
export async function persistEvidence(
  evidence: SettlementEvidence,
  directory = evidenceDirectory(),
) {
  const body = JSON.stringify(evidence);
  const id = createHash("sha256").update(body).digest("hex");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(directory, `${id}.json`), body, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return id;
}
export async function loadEvidence(
  id: string,
  directory = evidenceDirectory(),
): Promise<SettlementEvidence> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence ID");
  const body = await readFile(path.join(directory, `${id}.json`), "utf8");
  if (createHash("sha256").update(body).digest("hex") !== id)
    throw new Error("Evidence checksum mismatch");
  const evidence = JSON.parse(body) as SettlementEvidence;
  if (
    evidence.version !== 1 ||
    !evidence.input ||
    !evidence.match ||
    !evidence.game
  ) {
    throw new Error("Unsupported or incomplete evidence");
  }
  return evidence;
}
