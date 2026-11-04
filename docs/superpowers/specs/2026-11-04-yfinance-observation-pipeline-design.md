# Yfinance market snapshot

> Historical design: snapshot storage and initial loading are implemented. Later
> UI simplification removed routine freshness labels, and shared streaming now
> supplements HTTP reads. See `docs/PERN_STREAMING.md` for current behavior.

## Intent

Show the latest stored quote and a bundled set of instrument statistics promptly. Persist the last successful statistics response so a later provider failure does not erase values. Show separate quote and statistics ages; only quote and FX freshness affect paper-order eligibility.

## Current behavior

- The active PERN quote route waits for a yfinance refresh before returning `latest_quotes`.
- The worker refreshes instruments used by positions, open orders, watchlists, and alerts, using bounded concurrency and a short pass deadline.
- The private Python bridge uses yfinance history metadata for quote price and has short-lived in-flight-aware caching. It does not expose `Ticker.info`.
- Stock Detail renders ten statistics fields, but the active quote DTO contains none of them. The legacy Python backend already maps the requested Yahoo `Ticker.info` keys.
- Active PERN history is fetched separately and is not persisted.

## Goals

- Return stored quotes without waiting for the provider when a snapshot exists; request a bounded refresh in the background. A cold quote gets one bounded bootstrap fetch.
- Add statistics from `yfinance.Ticker.info`: open, day high/low, previous close, volume, average volume, market cap, trailing P/E, and 52-week high/low.
- Store each successful statistics response as one coherent snapshot, with one app-received timestamp. Preserve the whole snapshot and timestamp when a subsequent fetch fails.
- Use a common instrument market-snapshot read shape for quote and statistics while keeping their persistence and freshness independent. History stays on its range-specific path.
- Poll quotes while Stock Detail is open; show quote and statistics ages and mark old statistics stale.
- Keep provider concurrency bounded and preserve every existing order check.

## Non-goals

- Add another provider or a paid data plan.
- Persist every historical bar or build time-travel/replay trading.
- Change quote, FX, unit, session, corporate-action, or order eligibility policy.
- Treat `Ticker.info` as an execution-price feed or invent values Yahoo omits.

## Approaches considered

1. **Keep blocking quote refresh and add statistics to that response.** This couples page latency to provider calls and lets a statistics failure affect quote loading. Not selected.
2. **Serve a common instrument snapshot from storage and refresh quote/statistics sections independently.** This lets the page render stored values promptly, preserves last-successful statistics through outages, and retains independent freshness/eligibility rules. Selected.
3. **Add a durable market-data job queue.** This adds operational infrastructure before current bounded worker/bridge capacity is shown to be insufficient. Deferred.

## Design

- Introduce an `InstrumentMarketSnapshot` read shape containing the quote and optional statistics, each with its own `fetchedAt` and quality. The market-data module reads the existing quote row and a new latest-statistics row; Stock Detail consumes the common shape. Existing history remains separate and range-specific.
- For an existing quote, return the stored row immediately and start a bounded, de-duplicated refresh when due. The active-instrument worker remains responsible for execution observations. A missing quote performs one bounded bootstrap attempt.
- Add a private Python `/statistics?symbol=...` bridge route using `yf.Ticker(symbol).info`. Reuse the field mapping already present in the legacy backend. Treat metrics as optional and validate them; Yahoo can omit values for some tickers and instrument types.
- Add one latest-statistics row per instrument with nullable numeric fields, provider, and `fetched_at`. Update the row atomically only when an `info` response is received and validated. On timeout, missing response, or provider error, leave the previous row and timestamp untouched. A successful partial response replaces the snapshot; omitted fields are unavailable.
- Refresh statistics on demand from Stock Detail at most once per instrument per 30 minutes. Retry failures with bounded backoff. Mark the snapshot stale after 60 minutes without a successful fetch. Statistics refresh never updates quote or FX receipt times.
- Stock Detail loads quote and statistics independently, polls the stored snapshot while open (quote every 15 seconds; statistics at most every 5 minutes to discover due refreshes), and shows quote receipt age and statistics fetch age/stale state. Cached statistics remain visible as stale. Missing metrics remain unavailable.
- Keep `canTradeQuote` and server-side execution validation tied only to quote and FX state. Do not feed statistics or old history into order pricing.

## Constraints

- Add forward-only migration `005`; update the migration runner's version and ordered file list.
- Grant the restricted app role only the required statistics-table permissions.
- Keep the yfinance bridge private, bounded, and without database credentials.
- Preserve provider decimal values as strings until PostgreSQL; these display statistics never participate in JS financial calculations.
- `fetchedAt` means the app received the `Ticker.info` response; do not present it as a per-metric provider observation time.
- yfinance is intended for research/education and Yahoo's terms govern the downloaded data. Retain the existing personal/educational-use assumption.

## Acceptance

- An existing quote returns before a slow refresh completes; the next poll can show the newer persisted quote.
- A missing first quote gets one bounded bootstrap attempt.
- The common snapshot returns any stored statistics without waiting for `Ticker.info`.
- A failed statistics refresh leaves the entire previous snapshot and `fetchedAt` intact; the response/UI marks it stale by age.
- A valid response atomically updates its available fields; omitted fields remain unavailable, never fabricated.
- Quote/FX execution eligibility and ledger behavior are unchanged by statistics or history.
- Stock Detail displays Yahoo values where supplied, shows separate quote/statistics ages, and updates quotes without reload.
