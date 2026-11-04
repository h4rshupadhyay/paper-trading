# Shared quote streaming implementation plan

> **For agentic workers:** Use test-driven development for each boundary. Python
> and browser work may run in parallel under dispatching-parallel-agents; the
> primary agent owns Node integration and final verification.

**Goal:** Push real quotes to the trading UI with shared upstream demand and HTTP recovery.

**Architecture:** Python hub → elected worker → SQL quotes/notifications → API SSE → browser subscribers.

**Tech stack:** yfinance 1.8.0, Python asyncio, Node fetch, PostgreSQL LISTEN/NOTIFY, Express SSE, React.

**Spec:** `docs/superpowers/specs/2026-11-04-yfinance-streaming-design.md`.

## Global constraints

- Maximum 100 upstream symbols; internal subscription lease 45 seconds, renewal 15 seconds.
- Stream observations must be strictly newer; preserve SQL decimals and existing trade policy.
- One upstream Yahoo socket; rebuild clients on failure with capped backoff and jitter.
- No fabricated ticks, implicit currency-unit conversion or routine status UI.
- Preserve existing uncommitted demo work and private environment files.

## Review focus

- Replayed/missing timestamps cannot make prices fresh.
- Currency changes and pence quotes cannot silently change valuation units.
- Disconnect, logout and slow consumers release all bounded resources.
- Bursts cannot cause overlapping execution batches or duplicate fills.
- Late HTTP reads cannot undo quotes or confirmed user list edits.

## Tasks

- [x] Python: write failing tests in `services/yfinance/test_streaming.py`; implement
  `streaming.py`, private subscription/feed handlers and Docker copy; run offline tests.
- [x] Node persistence: failing database tests for newer ticks, replay, wrong units,
  HTTP suppression and transaction notifications; implement stream ingestion in
  `market-data/service.ts` without changing HTTP validation semantics.
- [x] Worker: test SSE framing, abort, dynamic subscriptions and sequential wake;
  implement `market-data/stream-worker.ts`, integrate start/stop/wake in `worker.ts`.
- [x] API: test authenticated SSE, validation, public payload, disconnect cleanup and
  session expiry; implement a shared PG notification hub and stream route; configure nginx.
- [x] Frontend: write failing transport/merge tests; implement shared EventSource and
  hooks, stock/watchlist/trade/portfolio updates and activity refresh; preserve fallbacks.
- [x] Integration: browser test a controlled quote stream and reconnection; run all
  suites, independent review, document limits and update `CHANGELOG.md`.
- [x] Commit only streaming-owned files/hunks, then rebuild the local services and
  verify health and actual stream reception where Yahoo market hours permit.

## Execution record

- Design records the implementation choices following the user's approval to proceed.
- Baseline `2f51fe8`; earlier demo edits remain unstaged. Known baseline: a worker
  shutdown/status assertion has failed intermittently, and a demo-history test has
  had a missing TypeScript annotation. Verify current state before fixing either.

- Implemented and verified all six feature boundaries; detailed results are in
  `docs/testing/STREAMING_2026-11-04.md`. Both isolated feature and combined working
  tree pass their backend, frontend and locked Python checks. All seven isolated
  browser scripts pass, including the authenticated SSE workflow.
- Real Yahoo delivery revealed protobuf string integers and missing NSE currency;
  tests now reproduce both. A missing unit uses only recent validated HTTP metadata,
  renewed by bounded periodic checks. Explicit ambiguous GBP remains on fallback.
- Same-second HTTP timestamp truncation is accepted only for an identical price and
  units, preserving the precise source timestamp. Replays cannot renew freshness.
- Independent final static review found no blocking defect. Provider load guarantees
  are outside the verified scope. Quote-triggered batches emit activity only after
  an actual order/alert change; unchanged ticks cause no portfolio reload.
- Rebuilt the combined schema-6-compatible working source, restarted the four
  application services without migrations or seed reset, confirmed readiness and
  health, and received a real RELIANCE.NS tick through the deployed private feed.
  Streaming is recorded as a focused Git commit; unrelated demo/history edits remain
  outside it. No remote push is included.
