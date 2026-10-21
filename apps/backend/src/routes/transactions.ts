import { Router } from "express";
import {
  sponsorPolicy,
  sponsorTransaction,
} from "../services/transaction-sponsor.js";
const router = Router();
// A valid allowlisted player's transaction signature is the authorization.
router.post("/sponsor", async (req, res) => {
  if (process.env.FEE_SPONSOR_ENABLED !== "true")
    return res.status(503).json({ error: "Fee sponsorship disabled" });
  if (
    typeof req.body?.signedTxXdr !== "string" ||
    req.body.signedTxXdr.length > 30000 ||
    req.body.optIn !== true
  )
    return res
      .status(400)
      .json({ error: "Signed transaction and explicit opt-in required" });
  try {
    return res.json(
      await sponsorTransaction(
        req.body.signedTxXdr,
        req.body.optIn,
        sponsorPolicy(),
      ),
    );
  } catch {
    // Neither secret keys nor request XDR are returned to clients.
    return res
      .status(400)
      .json({
        error:
          "Sponsorship rejected: check eligibility, limits, signature, expiry, and prior submission",
      });
  }
});
export default router;
