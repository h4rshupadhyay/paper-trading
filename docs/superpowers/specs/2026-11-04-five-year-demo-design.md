# Five-year demo history and portfolio chart

## Intent and chosen approach

The user selected a complete five-year history with matching portfolio-chart controls, continuing the prior requirement to use actual historical provider prices and FX. Extend the current PERN app and existing demo account. The alternative of extending only the chart while retaining recent trades was not selected: the ledger and displayed portfolio history must describe the same account.

This is a coordinated accounting, provider-history and chart change. The demo remains simulated paper trading; actual provider data supplies reference prices, FX and corporate-action facts. Do not promise a positive return: the chart must show the return the reconstructed portfolio actually earned.

## Dataset and chronology

Fetch approximately five calendar years ending at the latest completed source sessions, covering roughly November 2021 through November 2026 on the current client date. Keep AAPL, MSFT and RELIANCE.NS. Spread buys and partial sales across the five-year window, establish a holding early enough that the chart represents invested capital over the period, and include transactions in each year. Use a small deterministic schedule (approximately quarterly transactions) with conservative whole-share quantities and an initial INR 1,000,000 credit. Trade scheduling and quantities are builder decisions, subject to never shorting, maintaining nonnegative cash, making activity present in each year, and making later pending buys affordable. Final cash, cost bases and share quantities are recalculated, not forced to today's seeded numbers. Split-driven quantity changes are expected.

Use source exchange-local session dates and completed daily closes. Retrieve USD/INR daily history and apply only an observation available at or before the event cutoff; INR events use 1. Keep conservative daily-bar availability timestamps and bounded carry-forward across closures. For long cross-market holidays, skip a planned trade or valuation cutoff rather than silently substituting an arbitrarily old/future rate. Preserve full source observations, event units, retrieval times and a digest in a private artifact and compact provenance record. Invalid, incomplete or inconsistent data must fail before account mutation; never invent history or quietly switch providers.

## Stock splits and dividends

Replace the current blanket rejection of corporate-action windows with explicit historical accounting. Validate provider price/dividend units against split metadata before replay: historical Close can be split-normalized even when dividend adjustment is disabled. Normalize prices and dividend-per-share amounts to contemporaneous share units using reported split factors so applying a split in the ledger does not double-adjust the portfolio. Add characterization tests around a known source split and deterministic pre/post-split fixtures.

Record immutable, account-scoped historical corporate-action entries with instrument, source event date, action type, factor or per-share amount, entitlement quantity, FX observation, native/base amounts as applicable, and ordering/provenance. Splits change share quantity and per-share average cost while preserving total native and base cost. Reject unsupported actions or fractional-share outcomes beyond the application's quantity precision instead of inventing cash in lieu.

Dividends are gross simulated cash credits on the provider's ex-dividend date, explicitly labelled as that simulation convention because payable-date data is not supplied. Entitlement is based on shares held before that ex-date; same-day buys do not earn it. Use an as-of USD/INR rate for US credits, normal cash rounding, and no assumed reinvestment, withholding or fees. Action ordering must be deterministic, including same-day split/dividend combinations; ambiguous or inconsistent provider unit information causes refusal. Reconciliation independently replays trades and actions, validates dividend cash links and split quantity effects, and compares maintained positions and cash. Historical samples include those same events chronologically.

Add focused schema changes for these immutable entries, dividend cash-movement links/reason constraints and durable demo-version provenance. Keep runtime financial history immutable; migration/owner maintenance performs replacement. Existing accounts without corporate actions must behave identically. This scope is historical import/replay, not a new background corporate-action ingestion service for all users.

## Chart API and presentation

Preserve the current visual language. Dashboard Portfolio Growth and Analytics Portfolio Value Over Time both use the stock page's range buttons: 1D, 5D, 1M, 3M, 6M, 1Y, 5Y. Default to 5Y so the requested long history is visible immediately. These are range buttons with automatic sampling, matching the current stock-chart interaction rather than adding an unrelated manual interval selector.

Use bounded server-side portfolio-history aggregation with calendar-aware ranges: 1D/5-minute buckets, 5D/15-minute buckets, 1M/3M/6M/daily buckets, 1Y/weekly buckets and 5Y/monthly buckets. Keep the existing raw snapshot pagination contract for other callers. Pick the final actual sample in each bucket, include actual first and last range samples for honest change calculation, return chronological points with their true timestamps, and cap result size. Do not average portfolio values or fetch every five-minute snapshot over five years. Respect account ownership. Use calendar years rather than a fixed 1825-day shortcut to include leap years correctly.

Store daily historical valuations for the demo; existing worker snapshots provide intraday samples going forward. 1D/5D show available observations and clear empty/sparse states, without fabricating historical intraday paths. Backfilled daily samples remain identified as historical/stale. The 5Y view uses year-labelled ticks; 1Y uses month/year; shorter views use dates or times as appropriate. Tooltips include full dates and values. Derive displayed period change from the true boundary observations, not an arbitrarily truncated list or monthly average.

Keep controls accessible with visible selected state and aria-pressed labels, usable on narrow screens, available during loading/error/empty states, and safe against stale request responses during rapid selection. Refresh reloads the selected range. Use actual timestamps on a time axis so irregular gaps remain proportional. UI changes are limited to these portfolio charts and shared range definitions where useful; preserve other analytics sections.

## Existing demo upgrade and preservation

Upgrade the existing provider-based v2 demo with an explicit new versioned maintenance path; the current v1-to-v2 function must not mistake the v2 marker for a completed five-year upgrade. Maintain a durable version/provenance manifest so repeated upgrades are no-ops even after a journal is edited or deleted.

Before replacing financial history, verify the reserved identity, exact recognized v2 trades/ledger/projections against its retained source artifact, and absence of additional user trading or corporate-action entries. Refuse a mismatch. The existing local v2 source bundle is retained in the private backup described in docs/testing/DEMO_USER_2026-11-04.md; do not depend on mutable journal prose as accounting authority. Produce a new private backup and reviewable upgrade summary with row counts, date coverage, cash and reconciliation before committing the change.

Quiesce the worker using its existing batch lock and account/order locks. Replace only recognized seed financial history and dependent valuations in one transaction, recording corporate actions and the new manifest together. Keep user ID, password, sessions, user-created notes/watchlists/alerts/orders and cancellation decisions. Recognized untouched active seed thresholds may be refreshed near current quotes. Preserve the cancelled MSFT order. Set the demo's simulated account-history opening date consistently with the five-year opening credit without rewriting the actual user identity creation timestamp; the account-history date and registration date are separate facts.

Changes to cash and holdings are a necessary consequence of the selected reconstruction. Back up the prior state so it is recoverable. Other users and shared current market data must be untouched. A failed provider fetch, backup, validation or replay must leave the account unchanged. Resume worker operation after maintenance and verify its first current sample uses the new costs and action-aware cash sequence.

## Verification and delivery

Use deterministic provider-shaped five-year fixtures covering calendar years, different exchanges, missing FX, leap years, split-adjusted source units, split cost preservation, dividend entitlement/rounding/FX, same-day action ordering, partial sales and nonnegative cash. Independently assert exact resulting ledger, quantities, basis, realized trading P/L and dividend income; reconciliation must detect deliberate corruption of either event type.

Test range filtering, server aggregation and true boundary return values across monthly/year boundaries and leap years; verify no account crossover, no silent pagination truncation, and sparse intraday behavior. Test rapid range switches, accessible selected controls, loading/error recovery and refresh. Render and inspect desktop and narrow-screen chart output.

Test guarded v2 upgrade, complete rollback, credentials/cancellation/resource preservation, other-user isolation, worker fencing and repeated no-op behavior. Run relevant backend/provider/frontend suites, normal demo login and browser range-selection checks. Deploy locally, save private backup/provenance, apply the guarded upgrade and verify at least five calendar years of meaningful invested history, yearly chart labels, all range controls, exact live reconciliation and healthy public app/worker. No commit or push unless requested.

## Builder choices and boundaries

Builder decides exact transaction cadence and quantities, module names, aggregation endpoint naming, migration/table shape, and bounded provider request timeouts. The required economic conventions, preservation rules, source integrity, chart ranges and time sampling above are binding. Follow existing code and styling rather than introducing a new framework or chart library. Any inability to prove historical split/dividend units is a provider-validation blocker, not permission to create synthetic observations.
