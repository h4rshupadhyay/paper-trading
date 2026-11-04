# Shared quote streaming

With `MARKET_PROVIDER=yfinance`, the private Python service shares one Yahoo
WebSocket. An elected worker validates pushed observations and stores quotes in
PostgreSQL. API processes share one database notification listener each and serve
authenticated server-sent events to browsers. No additional account or API key is
needed for the documented yfinance streaming interface.

Stock prices, watchlists, index prices and open trade estimates merge new quotes.
Portfolio values reload from the internal API at most once per second while values
change; arithmetic remains in PostgreSQL. Repeated ticks at an unchanged price do
not trigger portfolio GETs. Inputs, chart controls and saved list edits survive
quote updates. Historical chart bars are not rewritten by current ticks.

Incoming quotes wake pending-order and alert evaluation, at most once per second,
using the same account locks and execution eligibility as scheduled work. HTTP
refresh and portfolio snapshot sampling retain their normal schedules. Activity
events reload owned records only after orders or alerts actually change; merely
receiving a quote does not make notifications or pending lists poll every second.

## Data validation and recovery

- Each stream tick retains the source's millisecond timestamp. Replayed, older,
  invalid, nonpositive and future observations cannot renew stream freshness.
- Protobuf integer strings are decoded explicitly. Provider precision hints remove
  float serialization artifacts; money arithmetic still uses SQL decimal values.
- Some NSE messages omit currency. Only independently validated HTTP metadata less
  than 90 seconds old may fill that missing field. The worker periodically verifies
  units through HTTP, with successful checks due every 60 seconds and bounded
  concurrency. It does not infer currency from ticker suffixes. Ambiguous explicit
  GBP ticks remain on HTTP fallback; explicit GBp retains the pence multiplier.
- Fresh streams suppress redundant HTTP quote fetches between those unit checks.
  Existing FX, history, search and statistics refresh policies remain independent.
- An identical HTTP quote with a whole-second source time may confirm the matching
  millisecond stream quote within that same second. It renews the real HTTP receipt
  while preserving the more precise source timestamp. Conflicting prices cannot
  use this path.
- Dropped connections rebuild fresh clients with capped exponential backoff and
  jitter. Heartbeats are transport health, not new market observations. Existing
  cached reads and HTTP refresh continue during stream outages.
- Browser connections close when hidden or logged out and recover on return.
  Session validity is checked on connection and every 10 seconds. Slow clients are
  disconnected, and API shutdown closes active feeds before draining connections.

These are protective implementation choices, not published Yahoo quotas: up to
100 subscribed symbols, prioritizing pending orders, positions and alerts before
watchlists and browser-only interests; eight private feed consumers; 50 browser
feeds per API process and two per user. Subscriptions renew every 15 seconds and
expire after 45 seconds without renewal. Browser-only interests expire after 90
seconds. HTTP unit checks retry no faster than every 30 seconds after failure.

The Yahoo client, queues, subscription maps and read buffers are bounded. No schema
migration or new npm/Python dependency is required. Fixture mode remains for local
tests and does not open a Yahoo socket.

## Run and verify

Use the normal [README startup](../README.md#getting-started). Rebuild the API,
worker, web and market-data images to activate changes:

```bash
docker compose --env-file .env.pern-compose.local up -d --build --wait
```

For deterministic checks, start the disposable test database first:

```bash
npm run test:db:up
npm run test:market
npm run test:web
npm run test:foundation
npm run test:streaming
npm run test:e2e
npm run test:deploy
```

Run Python tests in the pinned Python 3.12 environment with locked dependencies.
`test:streaming` exercises actual authenticated SSE with a controlled source, checks
stock/watchlist/trade/portfolio changes and input preservation, suppresses redundant
portfolio reads, and tests visibility recovery. It also runs in `test:e2e`.

See [verification evidence](testing/STREAMING_2026-11-04.md) for executed results and
real-provider probes. Yahoo delivery, market hours and instrument coverage still
determine whether a price changes each second; streaming does not remove exchange
delays or guarantee avoidance of provider throttling.
