# Demo history based on provider observations

The demo should demonstrate credible trading activity with correct accounting. Trades remain simulated paper trades; their reference prices and FX come from actual provider history.

## Approach

The user selected actual historical provider prices and FX over plausible synthetic history anchored to current quotes. This requires successful history downloads, but avoids invented performance. Keep the existing PERN app and yfinance sidecar. No fallback to invented observations when the provider fails.

## Historical dataset

Fetch roughly one month of unadjusted daily AAPL, MSFT, RELIANCE.NS and USDINR=X history. Choose five completed trading sessions with available stock and FX observations for the existing buy/buy/buy/partial-sale/partial-sale scenario. Use daily closing prices as reference prices and label them as simulated fills based on daily closes, not actual intraday executions. Respect exchange-local session dates, skip missing sessions, and reject incomplete, inconsistent or future observations. Use decimal arithmetic and normal settlement rounding. Derive cash movements, remaining average costs, realized P/L and historical portfolio samples from the same observations. Preserve provider/source dates and retrieval time in a demo provenance artifact or journal entry. Historical valuations use only observations available by the valuation cutoff, with bounded carry-forward across market closures; do not label backfilled samples as current fresh quotes. Detect corporate actions in the window and reject unsupported split/dividend treatment rather than silently inventing returns.

## Orders and alerts

Use latest validated reference prices to set an affordable AAPL buy limit below market, a RELIANCE sell stop below market and an affordable MSFT buy stop-limit above market with its limit above the stop. Keep one-share quantities and finite expiry. Use nearby, meaningful alert thresholds. Preserve terminal examples while replacing unrealistic quantities and prices in newly seeded accounts. These remain ordinary orders and may execute as prices move.

## Existing demo

Preserve user identity, password and user-edited resources, including the already-cancelled MSFT order. Implement an explicit development-only upgrade that locks the demo account, verifies the exact original seed executions and ledger, and refuses if subsequent trading makes replacement unsafe. Replace only recognized seed history and its dependent seed valuations, recomputing projections atomically; invalidate valuations derived from the replaced history. Retain unrelated users and shared market observations. Back up affected demo rows securely before applying the upgrade. Repeating the command must preserve the upgraded data and later edits. If the guard fails, report the conflict instead of resetting the account.

## Validation

Test with captured/provider-shaped observations: calendar selection, missing FX, look-ahead prevention, unsupported actions, exact ledger/cost reconciliation, affordable correctly ordered thresholds, failure rollback, preservation of credentials/cancelled orders/other users, repeatability, and refusal after additional trading. Run the relevant backend checks, deploy the local changes, perform the guarded upgrade and verify the live demo reconciliation and visible values.

## Scope

Update the seed, its explicit upgrade path, tests and documentation. Use existing schema where adequate; any necessary provenance field must have a focused migration. Keep UI changes limited to accurately communicating historical sample provenance. Do not change the market provider or reset the demo user.
