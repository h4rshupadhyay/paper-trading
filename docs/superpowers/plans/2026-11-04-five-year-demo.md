# Five-year Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for accounting integration and superpowers:dispatching-parallel-agents for the independent provider/chart tasks.

**Goal:** Apply a real-provider five-year demo ledger with split/dividend accounting and stock-style portfolio chart ranges.

**Architecture:** A versioned provider bundle carries contemporaneous daily prices and actions. A chronological SQL-decimal replay writes trades, immutable account actions, linked cash movements and daily valuations. A guarded v2→v3 maintenance command backs up the demo and records a durable manifest. A bounded history API supplies range-specific chart points.

**Tech Stack:** Existing yfinance/Python, TypeScript/PostgreSQL, React/Recharts and Vitest/Playwright.

**Spec:** docs/superpowers/specs/2026-11-04-five-year-demo-design.md

## Global Constraints

- Actual historical provider prices/FX; no invented observations or claimed positive returns.
- Preserve identity, credentials, sessions, user resources and cancelled MSFT order.
- Private backup, exact v2 source replay guard, worker/account locks, atomic replacement, repeat no-op.
- Preserve unrelated uncommitted work; no commit or push.

## Review Focus

- Source Close/dividend split normalization must not double-adjust historical units.
- Split-before-dividend-before-close-trade ordering and pre-ex-date entitlement.
- FX availability and different exchange calendars must not introduce future prices.
- Five-year API must remain bounded and include true range boundaries and leap years.
- Upgrade may only replace the recognized v2 seed, never later user trades.

### Task 1: Versioned five-year provider bundle (independent)

Files: services/yfinance/app.py, services/yfinance/test_app.py.
Interface: GET /demo-history?period=5y returns {version:3,source:'yfinance',priceBasis:'contemporaneous',fetchedAt,series:{AAPL,MSFT,RELIANCE.NS,'USDINR=X'}}. Each series has currency and items with sessionDate,closedAt,availableAt,close,dividend,split as decimal strings (no split='1', no dividend='0'). Existing unparameterized 1-month endpoint retains its contract.

- [x] Write and run failing tests for restoring split-adjusted prices/dividends, source dates/FX, incomplete bars, bad actions and parameters.
- [x] Implement bounded 5y export; reject unsupported capital gains/actions, retain split metadata.
- [x] Run provider suite and live five-year source probe.

### Task 2: Portfolio history API and chart (independent)

Files: apps/server/src/modules/portfolio/history.ts,http.ts; frontend/src/pages/Analytics.jsx, services/api.js, services/portfolioHistory.js; relevant tests.
Interface: GET /portfolio/history?period=1d|5d|1mo|3mo|6mo|1y|5y returns {items:[existing snapshot DTO fields],period,interval,firstValue,lastValue}. Owner-only, chronological, calendar-aware, <=1500 items, includes true first/last samples. Existing snapshot route unchanged. Frontend portfolioAPI.history(period) maps to existing chart shape and boundary values.

- [x] Failing HTTP tests for ownership, monthly/weekly/daily/intraday bucket selection, boundaries and calendar five years.
- [x] Implement bounded last-per-bucket + first/last query.
- [x] Match stock range controls, default 5y, year-aware numeric time axis, accessible selected/loading/error controls and narrow layout.
- [x] Test fast switching, date formatting, sparse states and real browser rendering. Run Impeccable detector once after completion.

### Task 3: Account action schema and five-year replay

Files: apps/server/migrations/006_account_actions.sql, platform/migrate.ts/config.ts, modules/accounts/reconciliation.ts, modules/demo/five-year.ts, five-year-accounting.ts, five-year-upgrade.ts, platform/seed-demo.ts; tests.
Interfaces: prepareFiveYearHistory(unknown) validated version 3 bundle; seedFiveYearDemo / upgradeFiveYearDemo with explicit owner pool, prior v2 source bundle and required private-backup callback. Durable demo_history_versions manifest records version, source digest and accounting digest. Immutable account_actions stores SPLIT or DIVIDEND; cash_movements gets linked DIVIDEND credits.

- [x] Write failing PostgreSQL tests: split basis preservation, gross dividend entitlement/cash/FX, partial sale cost, same-day order, exact replay and corruption detection.
- [x] Migration adds immutable action rows/links and manifest, no runtime history mutation privileges. Extend independent reconciliation to quantity deltas and dividend cash links.
- [x] Use initial INR 1m and quarterly trades over five years: small AAPL/MSFT buys from first quarter, later partial sales only from owned quantities; begin RELIANCE after 20 July 2023 to avoid its unsupported JFSL demerger entitlement, then account for its 2024 split. Keep enough cash for current orders. Reject unsupported action exposure.
- [x] Replay in source-time order: splits and dividend entitlement before same-day closing trades, SQL decimals, as-of FX, per-position rounded daily valuations. Batch source price data in temporary transaction tables rather than one query per snapshot/event.
- [x] Guard v2 by reconstructing exact original five-trade history from its saved provider bundle and comparing executions, cash, basis, sequence and original intent markers. Reject any added execution/action. Backup before writes, replace recognized financial rows, preserve terminal/user resources and refresh untouched seed thresholds.
- [x] CLI --five-years selects new seed/upgrade mode and requires prior v2 artifact for upgrade; private source archive and preview are persisted before commit. Repeats no-op via manifest. Verify rollback and isolation.

### Task 4: Review, local upgrade and verification

Files: README.md, docs/testing/DEMO_USER_2026-11-04.md and new verification report.

- [x] Review implementation against spec; fix important findings with failing regressions.
- [x] Run provider, backend, frontend, typecheck, build and browser range tests; visually inspect desktop/narrow chart.
- [x] Build/deploy local images and schema migration with compatibility coordination; back up existing demo, stop/fence worker, apply guarded v3 upgrade, restart worker/web proxy.
- [x] Verify five-year timestamps, action-aware reconciliation, meaningful yearly values, selected chart ranges, non-demo financial fingerprint and public health. Deliver exact evidence and artifact paths.

## Rulings

Work in the existing feature checkout because the required v2 seed is uncommitted here. Source time range uses calendar five years. Dividends are gross ex-date paper credits. RELIANCE enters after its July 2023 JFSL demerger; owning through that unsupported event would omit a real entitlement. Source: https://www.ril.com/sites/default/files/2024-08/RIL_ANNUALREPORT_2023-24.pdf . All other economic conventions follow the approved spec.
