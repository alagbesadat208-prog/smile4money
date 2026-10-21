import "dotenv/config";
import { pathToFileURL } from "node:url";
import { loadEvidence } from "../services/settlement-evidence.js";
import { evaluateStoredResult } from "../services/oracle-service.js";

/** Local operator command only. It has no submission callback or signing key. */
export async function replaySettlement(
  args: string[],
  enabled = process.env.SETTLEMENT_REPLAY_ENABLED,
) {
  if (enabled !== "true")
    throw new Error(
      "Operator replay is disabled; set SETTLEMENT_REPLAY_ENABLED=true",
    );
  if (args.length !== 2 || args[0] !== "--dry-run") {
    throw new Error(
      "Usage: npm run replay:settlement -- --dry-run <evidence-sha256>; submission is prohibited",
    );
  }
  const evidence = await loadEvidence(args[1]);
  return {
    dryRun: true,
    evidenceId: args[1],
    decision: evaluateStoredResult(
      evidence.match,
      evidence.input,
      evidence.game,
    ),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  replaySettlement(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
