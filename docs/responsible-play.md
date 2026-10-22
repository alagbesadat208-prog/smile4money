# Responsible Play

smile4money lets players wager real funds on chess games. These are the controls available for limiting or stopping that, exactly what each one covers, and where to get help.

## Controls

Both controls are in the **Responsible play** panel under the create-match form. They apply to the connected wallet address.

### Self-exclusion

Take a break from wagering for **24 hours, 7 days, 30 days or 6 months**.

- While it is active, this app will not start a new match (`create_match`) or a deposit (`deposit`) for that address. The check runs before anything is sent to the wallet.
- **It cannot be shortened or cancelled.** Choosing a period again only extends it; it never brings the end date forward.
- It ends on its own at the end of the period.
- Matches already funded are not affected: results are still settled and payouts still arrive, and `cancel_match` and `claim_timeout` stay available so funds are never stuck.

### Stake limit

Set a maximum stake per match.

- A stake above the limit is refused when creating or depositing into a match.
- **Lowering the limit takes effect immediately.** Raising or removing it takes effect after **24 hours**, so it can't be undone on impulse.

## What these controls do and do not cover

Read this carefully. The controls are a commitment aid, not a lock.

| | Covered | Not covered |
|---|---|---|
| **Where** | This app, in this browser | Other browsers, other devices, private windows |
| **How** | Stored in this browser's `localStorage`, keyed by wallet address | Clearing site data removes them |
| **On-chain** | — | The escrow contract does not know about them. Anyone with the wallet key can still call the contract directly or through another client. |
| **Accounts** | The wallet address they were set for | Other wallet addresses you control |

On-chain enforcement would need the escrow contract to keep an exclusion list and check it in `create_match` and `deposit`. Because the contract is permissionless, that would still not stop a player from using a new address. For a stronger barrier, combine self-exclusion with the steps below.

## Stronger steps

- **Move funds out of reach.** Transfer wagering funds to an account you don't hold keys for, or to someone you trust.
- **Block the site.** Use a site-blocking tool, or your device's parental or screen-time controls.
- **Talk to someone.** Free, confidential support:
  - International: [Gambling Therapy](https://www.gamblingtherapy.org)
  - United Kingdom: [GamCare](https://www.gamcare.org.uk), 0808 8020 133
  - United States: [National Council on Problem Gambling](https://www.ncpgambling.org), 1-800-GAMBLER

## For maintainers

- **Logic:** `apps/frontend/src/utils/responsible-play.ts`.
- **Panel:** `apps/frontend/src/components/ResponsiblePlay.tsx`.
- **Enforcement:** `CreateMatch` and `DepositStake` call `checkWagerAllowed` before validation or signing.
- **Tests:** `apps/frontend/tests/responsible-play.test.tsx` and `apps/frontend/tests/responsible-play-deposit.test.tsx`. They cover that an excluded or over-limit account cannot start either flow.
- **Copy rule:** never describe these controls as enforced on-chain or across devices.
