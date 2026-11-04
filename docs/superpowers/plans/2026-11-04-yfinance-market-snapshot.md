# Yfinance Market Snapshot Implementation Plan

> Historical design: snapshot storage and initial loading are implemented. Later
> UI simplification removed routine freshness labels, and shared streaming now
> supplements HTTP reads. See `docs/PERN_STREAMING.md` for current behavior.

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate Stock Detail statistics from yfinance `Ticker.info`, retain the last successful snapshot, and return stored quotes promptly with independent freshness.

**Architecture:** Extend the private Python bridge with a bounded statistics route, persist its validated response as one PostgreSQL snapshot per instrument, and expose quote plus statistics through a common market-snapshot read interface. The UI polls the snapshot while open; quote and statistics freshness remain independent, and only quote/FX can affect order eligibility.

**Tech Stack:** Python 3/yfinance, TypeScript/Express, PostgreSQL migrations, React.

**Spec:** `docs/superpowers/specs/2026-11-04-yfinance-observation-pipeline-design.md`

## Global Constraints

- Add forward-only migration `005`; update the migration runner's version and ordered file list.
- Keep the yfinance bridge private, bounded, and without database credentials.
- Preserve provider decimal values as strings until PostgreSQL; statistics never participate in JavaScript financial calculations.
- A failed statistics fetch leaves the last successful row and its timestamp unchanged.
- Quote/FX execution eligibility and ledger behavior do not change based on statistics or history.
- Refresh statistics at most once per instrument every 30 minutes; mark them stale after 60 minutes.
- Do not add or run tests in this task; implementation verification is outside the requested scope.

## Review Focus

- A cold quote can bootstrap, while an existing quote returns without waiting on upstream: preserve current failure behavior and prevent a rejected background refresh from becoming an unhandled rejection.
- `Ticker.info` may omit keys or return null/zero values: map supported keys explicitly, preserve valid zero values, and leave unavailable fields null.
- A statistics timeout or malformed field must not overwrite the prior snapshot or advance its successful `fetched_at`.
- Yahoo response numeric values may be float-like Python scalars: validate and stringify at the bridge; do not use them for order calculations.
- A delayed quote/statistics refresh must never change quote freshness or server-side trade eligibility.

## File Map

- `services/yfinance/app.py`: add bounded, cached `Ticker.info` retrieval and `/statistics` response mapping.
- `apps/server/migrations/005_instrument_statistics.sql`: add statistics snapshot storage and refresh-attempt state with restricted-role grants.
- `apps/server/src/platform/migrate.ts`: register migration 005.
- `apps/server/src/modules/market-data/provider.ts`: define optional provider statistics and market snapshot types.
- `apps/server/src/modules/market-data/yfinance-provider.ts`: call and validate the bridge statistics response.
- `apps/server/src/modules/market-data/service.ts`: persist/read statistics, enforce refresh cadence/backoff, and expose the common snapshot reader.
- `apps/server/src/modules/market-data/http.ts`: serve snapshot reads and trigger bounded background refreshes while retaining the quote route contract.
- `frontend/src/services/api.js`: map the market snapshot response without numeric arithmetic.
- `frontend/src/pages/StockDetail.jsx`: display statistics from the snapshot, show separate data ages/status, and poll for updates.
- `docs/PERN_YFINANCE.md`: describe the statistics source, cache semantics, and personal/educational use limitation.

## Tasks

### Task 1: Add the private yfinance statistics route

**Files:** `services/yfinance/app.py`

- [ ] Add a `MarketData.statistics(symbol)` method backed by `yf.Ticker(symbol).info`.
- [ ] Reuse the existing bounded executor, 15-second cache, and in-flight sharing. Cache by symbol and use one yfinance info request per refresh.
- [ ] Map Yahoo keys to `open`, `dayHigh`, `dayLow`, `previousClose`, `volume`, `averageVolume`, `marketCap`, `trailingPE`, `fiftyTwoWeekHigh`, and `fiftyTwoWeekLow`; preserve `0` as a value instead of treating it as absent.
- [ ] Convert finite provider scalars to decimal strings; return null for absent/unusable fields. Include the requested symbol and no client-controlled response fields.
- [ ] Add `/statistics` to the fixed route allowlist and dispatch it through the existing error/timeout handling.

### Task 2: Add persistence and the provider adapter

**Files:** `apps/server/migrations/005_instrument_statistics.sql`, `apps/server/src/platform/migrate.ts`, `apps/server/src/modules/market-data/provider.ts`, `apps/server/src/modules/market-data/yfinance-provider.ts`

- [ ] Create `latest_instrument_statistics` with one row per instrument, nullable numeric columns for the ten metrics, `fetched_at`, and `provider`; add an instrument statistics refresh-attempt timestamp for retry throttling.
- [ ] Grant `paper_app` only required SELECT/INSERT/UPDATE access; register version 5 in the migration runner.
- [ ] Define `ProviderStatistics` and `MarketSnapshot` types. Add an optional `statistics(instrument)` method to `MarketProvider` so existing providers remain compatible.
- [ ] Implement `YfinanceProvider.statistics`: call `/statistics`, verify the symbol matches the instrument, validate each nullable decimal and volume, and return decimal strings without JavaScript financial arithmetic.

### Task 3: Implement common snapshot reads and independent refreshes

**Files:** `apps/server/src/modules/market-data/service.ts`, `apps/server/src/modules/market-data/http.ts`

- [ ] Add `readMarketSnapshot(pool, id)` returning stored quote and optional statistics, with independent `quality`, `fetchedAt`, and provider values.
- [ ] Change quote reads with an existing row to return the stored quote promptly and start `refreshInstrument` without awaiting it; keep the single bounded bootstrap refresh for a missing quote.
- [ ] Add a statistics refresh function guarded by a dedicated PostgreSQL advisory lock. Persist the full nullable statistics payload atomically only after validation; leave the row untouched on failure.
- [ ] Throttle successful statistics refreshes to 30 minutes per instrument and use bounded retry backoff after failures; derive stale state at 60 minutes from `fetched_at`.
- [ ] Add an authenticated snapshot route. It returns stored data immediately, schedules due statistics refreshes in the background, and does not allow statistics state to affect quote/FX writes or trading.

### Task 4: Display the snapshot responsively

**Files:** `frontend/src/services/api.js`, `frontend/src/pages/StockDetail.jsx`

- [ ] Add a snapshot client mapping quote and statistics sections, preserving monetary values as API decimal strings until presentation formatting.
- [ ] Load quote and statistics from the common snapshot. Map the existing ten UI fields to their statistics DTO equivalents.
- [ ] Poll the snapshot every 15 seconds while Stock Detail is open; keep the existing page error/loading behavior for quote failures and let statistics remain independently unavailable/stale.
- [ ] Show quote receipt age and statistics fetch age/status; retain the last displayed statistics when a later response has a refresh failure.
- [ ] Keep order-button eligibility delegated to the unchanged `canTradeQuote` check.

### Task 5: Update operational documentation

**Files:** `docs/PERN_YFINANCE.md`

- [ ] Document the statistics fields, 30/60-minute freshness policy, failure-preserves-last-snapshot behavior, and separation from order eligibility.
- [ ] Note that yfinance is for research/education and Yahoo's terms govern data use.

## Execution Notes

- Work in the current workspace without changing the existing untracked `docs/PERN_FREE_PROVIDER_FEASIBILITY.md`.
- Do not run schema migration or connect to the configured local application database; migrations are code artifacts only in this task.
- No tests are added or run per the current task instruction.
