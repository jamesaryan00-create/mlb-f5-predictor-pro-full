# Price-aware paper evaluation v1

This is an experimental decision policy around the existing full-game model, not a retrained model or validated profit claim. It places no orders. Existing Kalshi records and historical observations remain unchanged.

## Frozen policy

- Evaluate both teams using their own model probability, bid/ask and timestamp.
- $1,000 budget including estimated multiplier-one taker fees, whole contracts, aggregate conservative whole-cent rounding.
- Expected net per position = probability × payout − cost. Do not use the overall Kalshi win rate as a substitute for a game's model probability.
- A candidate must have positive expected net at the captured ask and at a one-cent worse ask. If both sides qualify, take the larger stressed dollar expectation; exact ties resolve by side name for deterministic replay.
- Market favorite/underdog is determined from two-sided midpoints; tied prices are labeled EVEN.
- Both quotes must be valid, at most five minutes old, within one minute of each other, and pregame. Missing, stale, future or crossed quotes never qualify.
- Automated paper recording locks the first valid snapshot observed in the final 60 minutes before scheduled first pitch, with at most eight selections per official date. Valid strategic passes are locked too; invalid data does not become a strategic pass.
- Each game has at most one locked decision. No reconstruction of old winners/losers. The one-cent buffer and cap are policy assumptions, not optimized parameters.

## Dashboard versus ledger

The dashboard preview can change with updated inputs and the editable budget. Checkboxes only alter the preview portfolio; they do not place orders or edit the automatic paper ledger. The fixed forward evaluation always uses $1,000 and its captured model signal. Dashboard estimates are calculated from current model output, while locked decisions preserve the contemporaneous signal from the full-game capture pipeline. They may differ as quotes or inputs change.

The price-aware record shows wins/losses, pending picks, passes, hypothetical net P/L and ROI from settled paper entries. Its denominator and source are separate from the old Kalshi record. Every selected ledger row preserves both sides, asks, timestamps, costs, model signal, source capture filename/hash and policy version.

Grading uses matching MLB game/team IDs, scheduled start and a final untied score. Rescheduled, cancelled, unusual or missing finals remain pending for review. Contract-specific void treatment is not verified. Recorded profit assumes fills at the ask with adequate liquidity, no exit trade and settlement as indicated by the MLB final result. No live profitability guarantee follows from positive model-estimated return; calibration and execution remain unverified.

## Operation

Run `node scripts/price-paper.js` in the app root. Records are append-only `data/price-paper/decision-<gamePk>.json` and `grade-<gamePk>.json`. The droplet runs at minutes 3, 23 and 43 after existing Kalshi capture. The existing site sync copies only decision and grade JSON files into the deployed dashboard repository. A lock prevents overlapping runs. If an externally killed process leaves `run.lock`, investigate the interrupted run before removing the lock.

Sources: `lib/price-decision.js`, `lib/price-paper-record.js`, `scripts/price-paper.js`; UI: `pages/index.js`; record endpoint: `/api/price-record`. Tests exercise favorite/underdog selection, passes, adverse-entry costs, invalid timestamps/prices, portfolio sums and strict separation from legacy grading.
